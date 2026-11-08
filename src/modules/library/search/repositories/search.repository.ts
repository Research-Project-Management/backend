import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService, RedisCacheService } from '@/core';
import { Prisma } from '@prisma/client';
import {
  SearchOptions,
  FacetResult,
  SearchSpecificationBuilder,
  TextSearchSpecification,
  sanitizeSearchQuery,
} from '@/modules/library/search/domain/item-search.policy';
import { isProjectScopeId, LIBRARY_REDIS_KEYS, SingleFlightCoalescer, SearchQueryEngine } from '@/modules/library/core';
import { isValidUuid, sanitizeUuidSearchOptions, resolveSearchCollectionOptions, buildSearchItemsCacheKey, buildSearchFacetCacheKey, aggregateFacetGroups, buildSearchFtsMatchingIdsSql, buildSearchFtsSqlQuery, buildSearchTrgmFallbackSqlQuery, escapeLikePattern } from './search-sql.operations';

export type { SearchOptions, FacetResult };

@Injectable()
export class SearchRepository implements OnModuleInit {
  private readonly logger = new Logger(SearchRepository.name);
  private static readonly MAX_SCOPE_VERSIONS = 1000;
  private readonly scopeVersions = new Map<string, string>();
  private readonly singleFlight = new SingleFlightCoalescer();

  private applyJitter(baseTtlSeconds: number): number {
    const jitter = Math.floor(baseTtlSeconds * 0.1 * (Math.random() * 2 - 1));
    return Math.max(1, baseTtlSeconds + jitter);
  }

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

  private resolveScopeId(userId: string, options?: SearchOptions): string {
    return isProjectScopeId(options?.projectId) ? options.projectId.trim() : userId;
  }

  private setLocalScopeVersion(scopeId: string, version: string): void {
    if (this.scopeVersions.has(scopeId)) {
      this.scopeVersions.delete(scopeId);
    } else if (this.scopeVersions.size >= SearchRepository.MAX_SCOPE_VERSIONS) {
      const oldestKey = this.scopeVersions.keys().next().value;
      if (oldestKey !== undefined) this.scopeVersions.delete(oldestKey);
    }
    this.scopeVersions.set(scopeId, version);
  }

  async resolveScopeVersion(scopeId: string): Promise<string> {
    const normalizedScope = (scopeId || '').trim();
    if (!normalizedScope) return '1';

    if (this.cache?.get) {
      try {
        const versionKey = LIBRARY_REDIS_KEYS.searchVersion(normalizedScope);
        const redisVer = await this.cache.get<string>(versionKey);
        if ((typeof redisVer === 'string' || typeof redisVer === 'number') && String(redisVer).trim().length > 0) {
          const resolved = String(redisVer).trim();
          this.setLocalScopeVersion(normalizedScope, resolved);
          return resolved;
        }
        if (redisVer === null || redisVer === undefined) {
          const hadLocal = this.scopeVersions.has(normalizedScope);
          const prevVer = parseInt(this.scopeVersions.get(normalizedScope) || '1', 10) || 1;
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

  private buildBaseWhere(userId: string, options: SearchOptions): Prisma.LibraryItemWhereInput {
    return SearchSpecificationBuilder.baseFromOptions(userId, sanitizeUuidSearchOptions(options)).toPrismaWhere() as Prisma.LibraryItemWhereInput;
  }
  private buildTextWhereIlike(queryText: string, searchMode?: string): Prisma.LibraryItemWhereInput {
    return new TextSearchSpecification(queryText, searchMode).toPrismaWhere() as Prisma.LibraryItemWhereInput;
  }

  private static readonly ITEM_SEARCH_INCLUDE = (userId: string) => ({
    contributors: { orderBy: { orderIndex: 'asc' as const } },
    attachments: { where: { deletedAt: null }, take: 5 },
    itemTags: { include: { tag: true } },
    collectionItems: {
      where: { collection: { deletedAt: null } },
      include: { collection: true },
    },
    states: { where: { userId }, take: 1 },
    identifiers: true,
  });

  private hasInvalidUuidFilter(
    options: SearchOptions,
    checkCursor: boolean = false,
  ): boolean {
    return Boolean(
      (options.collectionId && !isValidUuid(options.collectionId)) ||
        (options.tagId && !isValidUuid(options.tagId)) ||
        (isProjectScopeId(options.projectId) &&
          !isValidUuid(options.projectId.trim())) ||
        (checkCursor && options.cursor && !isValidUuid(options.cursor)),
    );
  }

  private async resolveMatchingSearchWhere(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    rawOptions: SearchOptions,
  ): Promise<Prisma.LibraryItemWhereInput> {
    const resolvedOptions = await resolveSearchCollectionOptions(
      client,
      userId,
      rawOptions,
    );
    const q = resolvedOptions.q?.trim();
    const ftsSanitized = sanitizeSearchQuery(q);
    let textWhere: Prisma.LibraryItemWhereInput = {};

    if (q) {
      if (ftsSanitized && this.hasFtsColumn()) {
        try {
          const builtIds = buildSearchFtsMatchingIdsSql({
            userId,
            options: resolvedOptions,
            queryText: ftsSanitized,
            limit: 5000,
          });
          if (!builtIds) {
            textWhere = this.buildTextWhereIlike(q, resolvedOptions.searchMode);
          } else {
            const rawRunner =
              typeof client.$queryRawUnsafe === 'function'
                ? client
                : this.prisma;
            let ftsRows = await rawRunner.$queryRawUnsafe<
              Array<{ id: string }>
            >(builtIds.sql, ...builtIds.params);
            if (ftsRows.length === 0 && ftsSanitized.trim().length >= 3) {
              const trgmBuilt = buildSearchTrgmFallbackSqlQuery({
                userId,
                options: resolvedOptions,
                queryText: ftsSanitized,
                limit: 500,
              });
              if (trgmBuilt) {
                try {
                  ftsRows = await rawRunner.$queryRawUnsafe<
                    Array<{ id: string }>
                  >(trgmBuilt.sql, ...trgmBuilt.params);
                } catch {
                  // pg_trgm extension may not be installed in all environments; ignore silently
                }
              }
            }
            textWhere = { id: { in: ftsRows.map((r) => r.id) } };
          }
        } catch {
          textWhere = this.buildTextWhereIlike(q, resolvedOptions.searchMode);
        }
      } else {
        textWhere = this.buildTextWhereIlike(q, resolvedOptions.searchMode);
      }
    }

    return {
      ...this.buildBaseWhere(userId, resolvedOptions),
      ...textWhere,
    };
  }

  async prepareSearchOptions(
    userId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<SearchOptions> {
    if (this.hasInvalidUuidFilter(options)) return options;
    return resolveSearchCollectionOptions(this.getClient(tx), userId, options);
  }

  async searchItems(userId: string, options: SearchOptions, tx?: Prisma.TransactionClient) {
    if (this.hasInvalidUuidFilter(options, true)) {
      return { items: [], nextCursor: undefined, hasNextPage: false };
    }

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 500);
    const queryText = options.q?.trim();

    if (!tx && this.cache) {
      const scopeId = this.resolveScopeId(userId, options);
      const version = await this.resolveScopeVersion(scopeId);
      const cacheKey = buildSearchItemsCacheKey(userId, options, queryText, limit, version);

      if (typeof this.cache.wrap === 'function') {
        return this.singleFlight.execute(cacheKey, () =>
          this.cache!.wrap(
            cacheKey,
            () => this.executeSearchItems(userId, options, queryText, limit, tx),
            this.applyJitter(60),
          ),
        );
      }
      return this.singleFlight.execute(cacheKey, async () => {
        const cached = await this.cache!.get?.(cacheKey);
        if (cached && typeof cached === 'object' && 'items' in cached) {
          return cached as Awaited<ReturnType<typeof this.executeSearchItems>>;
        }
        const fresh = await this.executeSearchItems(userId, options, queryText, limit, tx);
        await this.cache!.set?.(cacheKey, fresh, this.applyJitter(60));
        return fresh;
      });
    }

    return this.executeSearchItems(userId, options, queryText, limit, tx);
  }

  private async executeSearchItems(
    userId: string,
    rawOptions: SearchOptions,
    queryText: string | undefined,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    const options = await resolveSearchCollectionOptions(this.getClient(tx), userId, rawOptions);
    const ftsSanitized = sanitizeSearchQuery(queryText);
    if (queryText && ftsSanitized && this.hasFtsColumn()) {
      try {
        return await this.searchItemsFts(userId, options, ftsSanitized, limit, tx);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`FTS query failed, falling back to ILIKE: ${errMsg}`);
      }
    }
    return await this.searchItemsIlike(userId, options, limit, tx);
  }

  private async searchItemsFts(
    userId: string,
    options: SearchOptions,
    queryText: string,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    const built = buildSearchFtsSqlQuery({ userId, options, queryText, limit });
    if (!built) return { items: [], nextCursor: undefined, hasNextPage: false };

    const client = this.getClient(tx);
    const rawRunner = typeof client.$queryRawUnsafe === 'function' ? client : this.prisma;
    let rows = await rawRunner.$queryRawUnsafe<Array<{ id: string }>>(built.sql, ...built.params);

    if (rows.length === 0 && !options.cursor && queryText.trim().length >= 3) {
      const trgmBuilt = buildSearchTrgmFallbackSqlQuery({
        userId,
        options,
        queryText,
        limit,
      });
      if (trgmBuilt) {
        try {
          rows = await rawRunner.$queryRawUnsafe<Array<{ id: string }>>(
            trgmBuilt.sql,
            ...trgmBuilt.params,
          );
        } catch {
          // pg_trgm extension may not be installed in all environments; ignore silently
        }
      }
    }

    let hasNextPage = false;
    let nextCursor: string | undefined;
    const ids = rows.map((r) => r.id);

    if (ids.length > limit) {
      hasNextPage = true;
      ids.pop();
      nextCursor = ids[ids.length - 1];
    }

    if (ids.length === 0) return { items: [], nextCursor: undefined, hasNextPage: false };

    const items = await client.libraryItem.findMany({
      where: {
        ...this.buildBaseWhere(userId, options),
        id: { in: ids },
      },
      include: SearchRepository.ITEM_SEARCH_INCLUDE(userId),
    });

    const orderMap = new Map(ids.map((id, idx) => [id, idx]));
    items.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

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

    const baseWhere = this.buildBaseWhere(userId, options);
    const textWhere = q
      ? this.buildTextWhereIlike(q, options.searchMode)
      : undefined;
    const where: Prisma.LibraryItemWhereInput = textWhere
      ? { AND: [baseWhere, textWhere] }
      : baseWhere;

    const effectiveSortBy = options.sortBy || options.orderBy;
    const effectiveSortDir: Prisma.SortOrder =
      (options.sortOrder || options.orderDirection) === 'asc' ? 'asc' : 'desc';

    const orderBy: Prisma.LibraryItemOrderByWithRelationInput[] =
      effectiveSortBy === 'year'
        ? [
            { year: { sort: effectiveSortDir, nulls: 'last' } },
            { id: effectiveSortDir },
          ]
        : effectiveSortBy === 'title'
          ? [{ title: effectiveSortDir }, { id: effectiveSortDir }]
          : effectiveSortBy === 'authors' ||
              effectiveSortBy === 'creator' ||
              effectiveSortBy === 'firstAuthor'
            ? [
                { firstAuthor: { sort: effectiveSortDir, nulls: 'last' } },
                { id: effectiveSortDir },
              ]
            : effectiveSortBy === 'publication' ||
                effectiveSortBy === 'publicationTitle'
              ? [
                  {
                    publicationTitle: {
                      sort: effectiveSortDir,
                      nulls: 'last',
                    },
                  },
                  { id: effectiveSortDir },
                ]
              : effectiveSortBy === 'citationKey'
                ? [
                    { citationKey: { sort: effectiveSortDir, nulls: 'last' } },
                    { id: effectiveSortDir },
                  ]
                : effectiveSortBy === 'deletedAt' ||
                    effectiveSortBy === 'dateDeleted'
                  ? [
                      { deletedAt: { sort: effectiveSortDir, nulls: 'last' } },
                      { id: effectiveSortDir },
                    ]
                  : effectiveSortBy === 'updatedAt' ||
                      effectiveSortBy === 'dateModified'
                    ? [
                        { updatedAt: effectiveSortDir },
                        { id: effectiveSortDir },
                      ]
                    : [
                        { createdAt: effectiveSortDir },
                        { id: effectiveSortDir },
                      ];

    const page = options.page && options.page > 0 ? options.page : 1;

    return client.libraryItem
      .findMany({
        where,
        orderBy,
        take: limit + 1,
        ...(options.cursor && isValidUuid(options.cursor)
          ? { cursor: { id: options.cursor }, skip: 1 }
          : page > 1
            ? { skip: (page - 1) * limit }
            : {}),
        include: SearchRepository.ITEM_SEARCH_INCLUDE(userId),
      })
      .then((items) => {
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
    if (this.hasInvalidUuidFilter(options)) {
      return 0;
    }

    const client = this.getClient(tx);
    if (!client.libraryItem?.count) return 0;
    const where = await this.resolveMatchingSearchWhere(client, userId, options);
    return client.libraryItem.count({ where });
  }


  async computeFacets(userId: string, options: SearchOptions, tx?: Prisma.TransactionClient): Promise<FacetResult> {
    const scopeId = this.resolveScopeId(userId, options);
    const version = await this.resolveScopeVersion(scopeId);
    const cacheKey = buildSearchFacetCacheKey(userId, options, version);

    const computeFreshFacets = async (): Promise<FacetResult> => {
      if (this.cache) {
        try {
          const cached = await this.cache.get<FacetResult>(cacheKey);
          if (cached && typeof cached === 'object' && 'itemTypes' in cached) return cached;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.debug(`Facet cache lookup error: ${errMsg}`);
        }
      }

      if (this.hasInvalidUuidFilter(options)) {
        return { itemTypes: {}, years: {}, tags: {} };
      }

      const client = this.getClient(tx);
      const where = await this.resolveMatchingSearchWhere(
        client,
        userId,
        options,
      );

      const [typeGroups, yearGroups, tagItems] = await Promise.all([
        client.libraryItem.groupBy({ by: ['itemType'], where, _count: { _all: true } }),
        client.libraryItem.groupBy({ by: ['year'], where, _count: { _all: true } }),
        client.libraryItemTag.findMany({ where: { item: where }, take: 1000, select: { tag: { select: { name: true } } } }),
      ]);

      const facetResult: FacetResult = aggregateFacetGroups({ typeGroups, yearGroups, tagItems });

      if (this.cache) {
        try {
          await this.cache.set(cacheKey, facetResult, this.applyJitter(120));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.debug(`Facet cache set error: ${message}`);
        }
      }

      return facetResult;
    };

    return tx ? computeFreshFacets() : this.singleFlight.execute(cacheKey, computeFreshFacets);
  }

  async invalidateFacets(scopeId: string): Promise<void> {
    const normalizedScope = (scopeId || '').trim();
    if (!normalizedScope) return;
    let baseVer = Number(this.scopeVersions.get(normalizedScope) || '1') || 1;
    if (this.cache?.get) {
      try {
        const redisVer = await this.cache.get<string>(LIBRARY_REDIS_KEYS.searchVersion(normalizedScope));
        const parsedRedis = Number(redisVer);
        if (Number.isFinite(parsedRedis) && parsedRedis > baseVer) baseVer = parsedRedis;
      } catch {
        // Non-fatal fallback to local version
      }
    }
    let nextVer = String(baseVer + 1);

    if (this.cache) {
      const versionKey = LIBRARY_REDIS_KEYS.searchVersion(normalizedScope);
      const cacheWithIncr = this.cache as RedisCacheService & {
        incr?: (key: string, ttlSeconds?: number) => Promise<number>;
      };
      if (typeof cacheWithIncr.incr === 'function') {
        try {
          const incremented = await cacheWithIncr.incr(versionKey, 86400);
          if (Number.isFinite(incremented) && incremented > 0) {
            nextVer = String(incremented);
          }
        } catch {
          // Fallback to set
        }
      }
      this.setLocalScopeVersion(normalizedScope, nextVer);
      await Promise.all([
        this.cache.delPattern?.(LIBRARY_REDIS_KEYS.searchFacetsPattern(normalizedScope)),
        this.cache.delPattern?.(LIBRARY_REDIS_KEYS.searchItemsPattern(normalizedScope)),
        typeof cacheWithIncr.incr !== 'function'
          ? this.cache.set?.(versionKey, nextVer, 86400)
          : Promise.resolve(),
      ]);
    } else {
      this.setLocalScopeVersion(normalizedScope, nextVer);
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
        WHERE c.relname = 'library_items'
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
          'PostgreSQL FTS: search_vector column not found on table "library_items" — run migration "add_catalog_item_fts" to enable. Falling back to ILIKE.',
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
        deletedAt: null,
        item: {
          deletedAt: null,
        },
      },
      include: {
        item: { select: { id: true, spaceId: true, createdById: true } },
      },
    });
  }

  // EventHandler Index Cleanup Operations
  async refreshItemSearchIndex(
    itemId: string,
    scopeId?: string,
  ): Promise<{ indexed: boolean; scopeId?: string }> {
    let resolvedScope = scopeId;
    if (itemId && this.prisma?.libraryItem?.findUnique) {
      const item = await this.prisma.libraryItem.findUnique({
        where: { id: itemId },
        select: {
          id: true,
          spaceId: true,
          createdById: true,
          deletedAt: true,
          title: true,
          abstract: true,
          publicationTitle: true,
          contributors: { select: { fullName: true, lastName: true } },
          itemTags: { select: { tag: { select: { name: true } } } },
        },
      });
      if (!item || item.deletedAt !== null) {
        if (resolvedScope) {
          await this.invalidateFacets(resolvedScope);
        }
        return { indexed: false, scopeId: resolvedScope };
      }
      const rawItem = item as { spaceId?: string; createdById?: string; projectId?: string | null; userId?: string };
      resolvedScope = resolvedScope || rawItem.spaceId || rawItem.projectId || rawItem.userId || rawItem.createdById;

      if (this.hasFtsColumn() && typeof this.prisma.$executeRaw === 'function') {
        try {
          const itemRec = item as Record<string, unknown>;
          const rawTitle = typeof itemRec.title === 'string' ? itemRec.title : '';
          const rawAbstract = typeof itemRec.abstract === 'string' ? itemRec.abstract : '';
          const rawPub = typeof itemRec.publicationTitle === 'string' ? itemRec.publicationTitle : '';
          const rawContributors = Array.isArray(itemRec.contributors)
            ? (itemRec.contributors as Array<{ fullName?: string | null; lastName?: string | null }>)
                .map((c) => `${c.fullName || ''} ${c.lastName || ''}`)
                .join(' ')
            : '';
          const rawTags = Array.isArray(itemRec.itemTags)
            ? (itemRec.itemTags as Array<{ tag?: { name?: string | null } }>)
                .map((it) => it.tag?.name || '')
                .join(' ')
            : '';

          const foldedTitle = SearchQueryEngine.stripDiacritics(rawTitle);
          const foldedAuthorsTags = SearchQueryEngine.stripDiacritics(
            `${rawContributors} ${rawTags}`,
          );
          const foldedAbstractPub = SearchQueryEngine.stripDiacritics(
            `${rawAbstract} ${rawPub}`,
          );

          await this.prisma.$executeRaw`
            UPDATE "library_items" i
            SET "search_vector" =
              setweight(to_tsvector('english', COALESCE(i."title", '') || ' ' || COALESCE(i."citation_key", '') || ' ' || COALESCE(i."doi", '')), 'A') ||
              setweight(to_tsvector('simple', ${foldedTitle}), 'A') ||
              setweight(to_tsvector('simple', COALESCE((
                SELECT string_agg(COALESCE(c."full_name", '') || ' ' || COALESCE(c."last_name", ''), ' ')
                FROM "contributors" c
                WHERE c."item_id" = i."id"
              ), '') || ' ' || COALESCE((
                SELECT string_agg(t."name", ' ')
                FROM "library_item_tags" it
                JOIN "library_tags" t ON t."id" = it."tag_id"
                WHERE it."item_id" = i."id"
              ), '') || ' ' || ${foldedAuthorsTags}), 'B') ||
              setweight(to_tsvector('english', COALESCE(i."abstract", '') || ' ' || ${foldedAbstractPub}), 'B') ||
              setweight(to_tsvector('english', COALESCE(i."publication_title", '')), 'C')
            WHERE i."id" = ${itemId}::uuid
          `;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.debug(
            `Best-effort search_vector update skipped for item ${itemId}: ${msg}`,
          );
        }
      }
    }

    if (resolvedScope) {
      await this.invalidateFacets(resolvedScope);
    }

    return { indexed: Boolean(itemId), scopeId: resolvedScope };
  }

  async deleteFullTextIndexByItemId(itemId: string): Promise<void> {
    await this.prisma.fullTextIndex.deleteMany({ where: { attachment: { itemId } } });
  }

  async deleteFullTextIndexByAttachmentId(attachmentId: string): Promise<void> {
    await this.prisma.fullTextIndex.deleteMany({ where: { attachmentId } });
  }

  async replaceAttachmentPageIndex(
    attachmentId: string,
    pages: Array<{ pageIndex: number; textContent: string; charOffset?: number; itemId?: string }>,
    itemId?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.fullTextIndex.deleteMany({ where: { attachmentId } });
      if (pages.length > 0) {
        for (let i = 0; i < pages.length; i += 100) {
          const chunk = pages.slice(i, i + 100);
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
  ): Promise<Array<{ pageIndex: number; textContent: string; charOffset: number }>> {
    const resolvedPageIndex = typeof pageIndexOrSearchTerm === 'number' ? pageIndexOrSearchTerm : undefined;
    const resolvedSearchTerm = typeof pageIndexOrSearchTerm === 'string' ? pageIndexOrSearchTerm : searchTerm;
    const trimmedTerm = resolvedSearchTerm?.trim();
    const escapedTerm = trimmedTerm ? escapeLikePattern(trimmedTerm) : undefined;
    const baseWhere: Prisma.FullTextIndexWhereInput = {
      attachmentId,
      attachment: { deletedAt: null, item: { deletedAt: null } },
      ...(resolvedPageIndex !== undefined ? { pageIndex: resolvedPageIndex } : {}),
    };

    const dbPages = await this.prisma.fullTextIndex.findMany({
      where: {
        ...baseWhere,
        ...(trimmedTerm ? { textContent: { contains: trimmedTerm, mode: 'insensitive' } } : {}),
      },
      orderBy: { pageIndex: 'asc' },
      take: trimmedTerm ? 200 : 1000,
    });

    if (dbPages.length === 0 && trimmedTerm) {
      const foldedTerm = SearchQueryEngine.stripDiacritics(trimmedTerm).trim();
      if (foldedTerm.length >= 2) {
        const allPages = await this.prisma.fullTextIndex.findMany({
          where: baseWhere,
          orderBy: { pageIndex: 'asc' },
          take: 500,
        });
        return allPages.map((p) => ({ pageIndex: p.pageIndex, textContent: p.textContent || '', charOffset: p.charOffset ?? 0 }));
      }
    }

    return dbPages.map((p) => ({ pageIndex: p.pageIndex, textContent: p.textContent || '', charOffset: p.charOffset ?? 0 }));
  }
}
