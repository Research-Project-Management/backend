import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { isUUID } from 'class-validator';
import { PrismaService } from '@/core';
import { RedisCacheService } from '@/core';
import { Prisma } from '@prisma/client';

import {
  SearchOptions,
  FacetResult,
} from '@/modules/library/search/types/search.types';
import { SearchSpecificationBuilder } from '@/modules/library/search/domain/search-specification.builder';
import {
  TextSearchSpecification,
  sanitizeSearchQuery,
} from '@/modules/library/search/domain/item-specifications';
import { isProjectScopeId, LIBRARY_REDIS_KEYS } from '@/modules/library/core';
import {
  isValidUuid,
  sanitizeUuidSearchOptions,
  buildSearchItemsCacheKey,
  buildSearchFacetCacheKey,
  aggregateFacetGroups,
  buildSearchFtsMatchingIdsSql,
  buildSearchFtsSqlQuery,
} from './search-sql.helper';

export type { SearchOptions, FacetResult };

@Injectable()
export class SearchRepository implements OnModuleInit {
  private readonly logger = new Logger(SearchRepository.name);
  private static readonly MAX_SCOPE_VERSIONS = 1000;
  private readonly scopeVersions = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.checkFtsColumnExists();
  }

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  private isProjectScope(projectId?: string): projectId is string {
    return isProjectScopeId(projectId);
  }

  private resolveScopeId(userId: string, options?: SearchOptions): string {
    return this.isProjectScope(options?.projectId)
      ? options!.projectId.trim()
      : userId;
  }

  private setLocalScopeVersion(scopeId: string, version: string): void {
    if (this.scopeVersions.has(scopeId)) {
      this.scopeVersions.delete(scopeId);
    } else if (this.scopeVersions.size >= SearchRepository.MAX_SCOPE_VERSIONS) {
      const oldestKey = this.scopeVersions.keys().next().value;
      if (oldestKey !== undefined) {
        this.scopeVersions.delete(oldestKey);
      }
    }
    this.scopeVersions.set(scopeId, version);
  }

  private getScopeVersion(scopeId: string): string {
    return this.scopeVersions.get(scopeId) || '1';
  }

  async resolveScopeVersion(scopeId: string): Promise<string> {
    const normalizedScope = (scopeId || '').trim();
    if (!normalizedScope) return '1';

    if (this.cache?.get) {
      try {
        const versionKey = LIBRARY_REDIS_KEYS.searchVersion(normalizedScope);
        const redisVer = await this.cache.get<string>(versionKey);
        if (
          (typeof redisVer === 'string' || typeof redisVer === 'number') &&
          String(redisVer).trim().length > 0
        ) {
          const resolved = String(redisVer).trim();
          this.setLocalScopeVersion(normalizedScope, resolved);
          return resolved;
        }
        if (redisVer === null || redisVer === undefined) {
          const hadLocal = this.scopeVersions.has(normalizedScope);
          const prevVer =
            parseInt(this.scopeVersions.get(normalizedScope) || '1', 10) || 1;
          const nextVer = hadLocal ? String(prevVer + 1) : '1';
          this.setLocalScopeVersion(normalizedScope, nextVer);
          await this.cache.set?.(versionKey, nextVer, 86400);
          return nextVer;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Scope version lookup fallback: ${errMsg}`);
      }
    }

    const fallbackVer = this.scopeVersions.get(normalizedScope) || '1';
    this.setLocalScopeVersion(normalizedScope, fallbackVer);
    return fallbackVer;
  }

  private sanitizeUuidOptions(options: SearchOptions): SearchOptions {
    return sanitizeUuidSearchOptions(options);
  }

  private buildSearchCacheKey(
    userId: string,
    options: SearchOptions,
    queryText: string | undefined,
    limit: number,
    version: string = '1',
  ): string {
    return buildSearchItemsCacheKey(userId, options, queryText, limit, version);
  }

  /**
   * Builds the base Prisma WHERE clause for non-text filters using Specification Pattern.
   * Text search is handled separately via raw FTS or ILIKE fallback.
   */
  private buildBaseWhere(
    userId: string,
    options: SearchOptions,
  ): Prisma.ItemWhereInput {
    return SearchSpecificationBuilder.baseFromOptions(
      userId,
      this.sanitizeUuidOptions(options),
    ).toPrismaWhere();
  }

  /**
   * Builds a Prisma text-search OR clause using Specification Pattern.
   * Used as fallback when tsvector is not available.
   */
  private buildTextWhereIlike(queryText: string): Prisma.ItemWhereInput {
    return new TextSearchSpecification(queryText).toPrismaWhere();
  }

  async searchItems(
    userId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ) {
    if (
      (options.collectionId && !isValidUuid(options.collectionId)) ||
      (options.tagId && !isValidUuid(options.tagId)) ||
      (this.isProjectScope(options.projectId) &&
        !isValidUuid(options.projectId.trim())) ||
      (options.cursor && !isValidUuid(options.cursor))
    ) {
      return { items: [], nextCursor: undefined, hasNextPage: false };
    }

    const limit = Math.min(options.limit ?? 20, 100);
    const queryText = options.q?.trim();

    if (!tx && this.cache) {
      const scopeId = this.resolveScopeId(userId, options);
      const version = await this.resolveScopeVersion(scopeId);
      const cacheKey = this.buildSearchCacheKey(
        userId,
        options,
        queryText,
        limit,
        version,
      );

      if (typeof this.cache.wrap === 'function') {
        return this.cache.wrap(
          cacheKey,
          () => this.executeSearchItems(userId, options, queryText, limit, tx),
          60, // 60s TTL for fast navigation & debounced typing
        );
      }
      const cached = await this.cache.get?.(cacheKey);
      if (cached && typeof cached === 'object' && 'items' in cached) {
        return cached as Awaited<ReturnType<typeof this.executeSearchItems>>;
      }
      const fresh = await this.executeSearchItems(
        userId,
        options,
        queryText,
        limit,
        tx,
      );
      await this.cache.set?.(cacheKey, fresh, 60);
      return fresh;
    }

    return this.executeSearchItems(userId, options, queryText, limit, tx);
  }

  private async executeSearchItems(
    userId: string,
    options: SearchOptions,
    queryText: string | undefined,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    // Full-Text Search via PostgreSQL tsvector
    // Uses generated column `search_vector` (GIN index) added by migration
    // `add_catalog_item_fts`. Falls back to ILIKE if migration hasn't run yet
    // or if the query consists only of punctuation/symbols that strip to empty in tsquery.
    const ftsSanitized = sanitizeSearchQuery(queryText);
    if (queryText && ftsSanitized && this.hasFtsColumn()) {
      try {
        return await this.searchItemsFts(
          userId,
          options,
          ftsSanitized,
          limit,
          tx,
        );
      } catch (err: unknown) {
        // Column might not exist yet (pre-migration) — fall through to ILIKE
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`FTS query failed, falling back to ILIKE: ${errMsg}`);
      }
    }
    // ILIKE fallback (pre-migration or no text query)
    return await this.searchItemsIlike(userId, options, limit, tx);
  }

  private async searchItemsFts(
    userId: string,
    options: SearchOptions,
    queryText: string,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    const built = buildSearchFtsSqlQuery({
      userId,
      options,
      queryText,
      limit,
    });
    if (!built) {
      return { items: [], nextCursor: undefined, hasNextPage: false };
    }

    const client = this.getClient(tx);
    const rawRunner =
      typeof client.$queryRawUnsafe === 'function' ? client : this.prisma;
    const rows = await rawRunner.$queryRawUnsafe<Array<{ id: string }>>(
      built.sql,
      ...built.params,
    );

    let hasNextPage = false;
    let nextCursor: string | undefined;
    const ids = rows.map((r) => r.id);

    if (ids.length > limit) {
      hasNextPage = true;
      ids.pop();
      nextCursor = ids[ids.length - 1];
    }

    if (ids.length === 0) {
      return { items: [], nextCursor: undefined, hasNextPage: false };
    }

    // Fetch full records with relations in original ranked order
    const items = await client.item.findMany({
      where: { id: { in: ids } },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { where: { deletedAt: null }, take: 5 },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
        states: { where: { userId }, take: 1 },
        identifiers: true,
      },
    });

    // Restore FTS rank order
    const orderMap = new Map(ids.map((id, idx) => [id, idx]));
    items.sort(
      (a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999),
    );

    return { items, nextCursor, hasNextPage };
  }

  private async searchItemsIlike(
    userId: string,
    options: SearchOptions,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const q = options.q?.trim();

    const where: Prisma.ItemWhereInput = {
      ...this.buildBaseWhere(userId, options),
      ...(q ? this.buildTextWhereIlike(q) : {}),
    };

    const orderBy: Prisma.ItemOrderByWithRelationInput[] =
      options.sortBy === 'year'
        ? [{ year: options.sortOrder || 'desc' }, { id: 'desc' }]
        : options.sortBy === 'title'
          ? [{ title: options.sortOrder || 'asc' }, { id: 'desc' }]
          : [{ createdAt: options.sortOrder || 'desc' }, { id: 'desc' }];

    return client.item.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor && isValidUuid(options.cursor)
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { where: { deletedAt: null }, take: 5 },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
        states: { where: { userId }, take: 1 },
        identifiers: true,
      },
    }).then((items) => {
      let hasNextPage = false;
      let nextCursor: string | undefined;

      if (items.length > limit) {
        hasNextPage = true;
        items.pop();
        nextCursor = items[items.length - 1]?.id;
      }

      return { items, nextCursor, hasNextPage };
    });
  }

  async countSearchItems(
    userId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (
      (options.collectionId && !isValidUuid(options.collectionId)) ||
      (options.tagId && !isValidUuid(options.tagId)) ||
      (this.isProjectScope(options.projectId) &&
        !isValidUuid(options.projectId.trim()))
    ) {
      return 0;
    }

    const client = this.getClient(tx);
    const q = options.q?.trim();
    const ftsSanitized = sanitizeSearchQuery(q);
    let textWhere: Prisma.ItemWhereInput = {};

    if (q) {
      if (ftsSanitized && this.hasFtsColumn()) {
        try {
          const builtIds = buildSearchFtsMatchingIdsSql({
            userId,
            options,
            queryText: ftsSanitized,
            limit: 5000,
          });
          if (!builtIds) {
            textWhere = this.buildTextWhereIlike(q);
          } else {
            const rawRunner =
              typeof client.$queryRawUnsafe === 'function'
                ? client
                : this.prisma;
            const ftsRows = await rawRunner.$queryRawUnsafe<
              Array<{ id: string }>
            >(builtIds.sql, ...builtIds.params);
            textWhere = { id: { in: ftsRows.map((r) => r.id) } };
          }
        } catch {
          textWhere = this.buildTextWhereIlike(q);
        }
      } else {
        textWhere = this.buildTextWhereIlike(q);
      }
    }

    const where: Prisma.ItemWhereInput = {
      ...this.buildBaseWhere(userId, options),
      ...textWhere,
    };

    if (!client.item?.count) {
      return 0;
    }
    return client.item.count({ where });
  }

  async getFacets(
    userId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<FacetResult> {
    return this.computeFacets(userId, options, tx);
  }

  async computeFacets(
    userId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<FacetResult> {
    const scopeId = this.resolveScopeId(userId, options);
    const version = await this.resolveScopeVersion(scopeId);
    const cacheKey = buildSearchFacetCacheKey(userId, options, version);

    if (this.cache) {
      try {
        const cached = await this.cache.get<FacetResult>(cacheKey);
        if (cached && typeof cached === 'object' && 'itemTypes' in cached) {
          return cached;
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Facet cache lookup error: ${errMsg}`);
      }
    }

    if (
      (options.collectionId && !isValidUuid(options.collectionId)) ||
      (options.tagId && !isValidUuid(options.tagId)) ||
      (this.isProjectScope(options.projectId) &&
        !isValidUuid(options.projectId.trim()))
    ) {
      return { itemTypes: {}, years: {}, tags: {} };
    }

    const client = this.getClient(tx);
    const q = options.q?.trim();
    const ftsSanitized = sanitizeSearchQuery(q);
    let textWhere: Prisma.ItemWhereInput = {};

    if (q) {
      if (ftsSanitized && this.hasFtsColumn()) {
        try {
          const builtIds = buildSearchFtsMatchingIdsSql({
            userId,
            options,
            queryText: ftsSanitized,
            limit: 5000,
          });
          if (!builtIds) {
            textWhere = this.buildTextWhereIlike(q);
          } else {
            const rawRunner =
              typeof client.$queryRawUnsafe === 'function'
                ? client
                : this.prisma;
            const ftsRows = await rawRunner.$queryRawUnsafe<
              Array<{ id: string }>
            >(builtIds.sql, ...builtIds.params);
            textWhere = { id: { in: ftsRows.map((r) => r.id) } };
          }
        } catch {
          textWhere = this.buildTextWhereIlike(q);
        }
      } else {
        textWhere = this.buildTextWhereIlike(q);
      }
    }

    const where: Prisma.ItemWhereInput = {
      ...this.buildBaseWhere(userId, options),
      ...textWhere,
    };

    const [typeGroups, yearGroups, tagItems] = await Promise.all([
      client.item.groupBy({
        by: ['itemType'],
        where,
        _count: { _all: true },
      }),
      client.item.groupBy({
        by: ['year'],
        where,
        _count: { _all: true },
      }),
      client.itemTag.findMany({
        where: { item: where },
        take: 1000,
        select: { tag: { select: { name: true } } },
      }),
    ]);

    const facetResult: FacetResult = aggregateFacetGroups({
      typeGroups,
      yearGroups,
      tagItems,
    });

    // 3. Cache computed facet result (TTL: 120 seconds)
    if (this.cache) {
      try {
        await this.cache.set(cacheKey, facetResult, 120);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Facet cache set error: ${message}`);
      }
    }

    return facetResult;
  }

  async invalidateFacets(scopeId: string): Promise<void> {
    const normalizedScope = (scopeId || '').trim();
    if (!normalizedScope) return;
    let baseVer = Number(this.scopeVersions.get(normalizedScope) || '1') || 1;
    if (this.cache?.get) {
      try {
        const redisVer = await this.cache.get<string>(
          LIBRARY_REDIS_KEYS.searchVersion(normalizedScope),
        );
        const parsedRedis = Number(redisVer);
        if (Number.isFinite(parsedRedis) && parsedRedis > baseVer) {
          baseVer = parsedRedis;
        }
      } catch {
        // Non-fatal fallback to local version
      }
    }
    const nextVer = String(baseVer + 1);
    this.setLocalScopeVersion(normalizedScope, nextVer);

    if (this.cache) {
      const versionKey = LIBRARY_REDIS_KEYS.searchVersion(normalizedScope);
      await Promise.all([
        this.cache.delPattern?.(
          LIBRARY_REDIS_KEYS.searchFacetsPattern(normalizedScope),
        ),
        this.cache.delPattern?.(
          LIBRARY_REDIS_KEYS.searchItemsPattern(normalizedScope),
        ),
        this.cache.set?.(versionKey, nextVer, 86400),
      ]);
    }
  }

  /**
   * Checks if the search_vector FTS column exists on Item.
   * Used to gracefully degrade to ILIKE before the migration has run.
   *
   * Cached after first successful query to avoid repeated pg_attribute checks.
   */
  private ftsColumnExists: boolean | null = null;

  private hasFtsColumn(): boolean {
    // Optimistic: assume it exists unless explicitly determined otherwise
    // The actual check happens via try/catch in searchItemsFts
    return this.ftsColumnExists !== false;
  }

  /**
   * Call during app startup (OnModuleInit) to warm the FTS column check.
   */
  async checkFtsColumnExists(): Promise<void> {
    try {
      const res = await this.prisma.$queryRaw<unknown[]>`
        SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'items'
          AND a.attname = 'search_vector'
          AND NOT a.attisdropped
        LIMIT 1
      `;
      this.ftsColumnExists = Array.isArray(res) && res.length > 0;
      if (this.ftsColumnExists) {
        this.logger.log(
          'PostgreSQL FTS: search_vector column found — full-text search enabled',
        );
      } else {
        this.logger.warn(
          'PostgreSQL FTS: search_vector column not found on table "items" — run migration "add_catalog_item_fts" to enable. Falling back to ILIKE.',
        );
      }
    } catch (err: unknown) {
      this.ftsColumnExists = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `PostgreSQL FTS: search_vector column check failed (${errMsg}) — falling back to ILIKE.`,
      );
    }
  }

  // Search Attachment Anchor Operations
  async findAttachmentWithItem(attachmentId: string) {
    return this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        item: {
          deletedAt: null,
        },
      },
      include: {
        item: { select: { id: true, userId: true, projectId: true } },
      },
    });
  }

  // EventHandler Index Cleanup Operations
  async refreshItemSearchIndex(
    itemId: string,
    scopeId?: string,
  ): Promise<{ indexed: boolean; scopeId?: string }> {
    let resolvedScope = scopeId;
    if (itemId && this.prisma?.item?.findUnique) {
      const item = await this.prisma.item.findUnique({
        where: { id: itemId },
        select: { id: true, userId: true, projectId: true, deletedAt: true },
      });
      if (!item || item.deletedAt !== null) {
        if (resolvedScope) {
          await this.invalidateFacets(resolvedScope);
        }
        return { indexed: false, scopeId: resolvedScope };
      }
      resolvedScope = resolvedScope || item.projectId || item.userId;
    }

    if (resolvedScope) {
      await this.invalidateFacets(resolvedScope);
    }

    return { indexed: Boolean(itemId), scopeId: resolvedScope };
  }

  async deleteFullTextIndexByItemId(itemId: string): Promise<void> {
    await this.prisma.fullTextIndex.deleteMany({
      where: { attachment: { itemId } },
    });
  }

  async deleteFullTextIndexByAttachmentId(attachmentId: string): Promise<void> {
    await this.prisma.fullTextIndex.deleteMany({
      where: { attachmentId },
    });
  }

  async replaceAttachmentPageIndex(
    attachmentId: string,
    pages: Array<{
      pageIndex: number;
      textContent: string;
      charOffset?: number;
    }>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.fullTextIndex.deleteMany({
        where: { attachmentId },
      });

      if (pages.length > 0) {
        const CHUNK_SIZE = 100;
        for (let i = 0; i < pages.length; i += CHUNK_SIZE) {
          const chunk = pages.slice(i, i + CHUNK_SIZE);
          await tx.fullTextIndex.createMany({
            data: chunk.map((page) => ({
              attachmentId,
              pageIndex: page.pageIndex,
              textContent: (page.textContent || '').replace(/\0/g, ''),
              charOffset: page.charOffset ?? 0,
            })),
          });
        }
      }
    });
  }

  async findAttachmentPages(
    attachmentId: string,
    pageIndexOrSearchTerm?: number | string,
    searchTerm?: string,
  ): Promise<
    Array<{ pageIndex: number; textContent: string; charOffset: number }>
  > {
    const resolvedPageIndex =
      typeof pageIndexOrSearchTerm === 'number'
        ? pageIndexOrSearchTerm
        : undefined;
    const resolvedSearchTerm =
      typeof pageIndexOrSearchTerm === 'string'
        ? pageIndexOrSearchTerm
        : searchTerm;
    const trimmedTerm = resolvedSearchTerm?.trim();

    const dbPages = await this.prisma.fullTextIndex.findMany({
      where: {
        attachmentId,
        ...(resolvedPageIndex !== undefined
          ? { pageIndex: resolvedPageIndex }
          : {}),
        ...(trimmedTerm
          ? {
              textContent: {
                contains: trimmedTerm,
                mode: 'insensitive',
              },
            }
          : {}),
      },
      orderBy: { pageIndex: 'asc' },
      ...(trimmedTerm ? { take: 50 } : {}),
    });

    return dbPages.map((dbPage) => ({
      pageIndex: dbPage.pageIndex,
      textContent: dbPage.textContent || '',
      charOffset: dbPage.charOffset ?? 0,
    }));
  }
}
