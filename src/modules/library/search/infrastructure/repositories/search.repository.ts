import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../../../../core/database/prisma.service';
import { RedisCacheService } from '../../../../../core/cache/redis.service';
import { Prisma } from '@prisma/client';

import { SearchOptions, FacetResult } from '../../domain/types/search.types';
import { buildBaseSearchWhere } from '../../application/utils/search.utils';
import { SearchSpecificationBuilder } from '../../domain/specifications/search-specification.builder';
import { TextSearchSpecification } from '../../domain/specifications/item-specifications';

export { SearchOptions, FacetResult };

@Injectable()
export class SearchRepository implements OnModuleInit {
  private readonly logger = new Logger(SearchRepository.name);

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
      options,
    ).toPrismaWhere();
  }

  /**
   * Builds a Prisma text-search OR clause using Specification Pattern.
   * Used as fallback when tsvector is not available.
   */
  private buildTextWhereIlike(q: string): Prisma.ItemWhereInput {
    return new TextSearchSpecification(q).toPrismaWhere();
  }

  async searchItems(
    userId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ) {
    const limit = Math.min(options.limit ?? 20, 100);
    const q = options.q?.trim();

    // ── Full-Text Search via PostgreSQL tsvector ────────────────────────────
    // Uses generated column `search_vector` (GIN index) added by migration
    // `add_catalog_item_fts`. Falls back to ILIKE if migration hasn't run yet.
    if (q && this.hasFtsColumn()) {
      try {
        return await this.searchItemsFts(userId, options, q, limit, tx);
      } catch (err: any) {
        // Column might not exist yet (pre-migration) — fall through to ILIKE
        this.logger.warn(
          `FTS query failed, falling back to ILIKE: ${err?.message}`,
        );
      }
    }
    // ── ILIKE fallback (pre-migration or no text query) ────────────────────
    return await this.searchItemsIlike(userId, options, limit, tx);
  }

  private async searchItemsFts(
    userId: string,
    options: SearchOptions,
    q: string,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    // Build structured filters as SQL fragment
    const hasProject = Boolean(
      options.projectId &&
        options.projectId !== 'user' &&
        options.projectId !== 'me' &&
        options.projectId !== 'personal',
    );
    const baseFilters: string[] = [
      hasProject ? `project_id = $1::uuid` : `user_id = $1::uuid`,
      `deleted_at IS NULL`,
      `search_vector @@ plainto_tsquery('english', $2)`,
    ];
    const params: any[] = [hasProject ? options.projectId : userId, q];
    let paramIdx = 3;

    if (options.itemType) {
      baseFilters.push(`item_type = $${paramIdx++}`);
      params.push(options.itemType);
    }
    if (options.yearFrom) {
      baseFilters.push(`year >= $${paramIdx++}`);
      params.push(options.yearFrom);
    }
    if (options.yearTo) {
      baseFilters.push(`year <= $${paramIdx++}`);
      params.push(options.yearTo);
    }
    // Collection and tag filters via subquery
    if (options.collectionId) {
      baseFilters.push(
        `EXISTS (SELECT 1 FROM "collection_items" ci WHERE ci.item_id = "items".id AND ci.collection_id = $${paramIdx++}::uuid)`,
      );
      params.push(options.collectionId);
    }
    if (options.tagId) {
      baseFilters.push(
        `EXISTS (SELECT 1 FROM "item_tags" it WHERE it.item_id = "items".id AND it.tag_id = $${paramIdx++}::uuid)`,
      );
      params.push(options.tagId);
    }

    const whereClause = baseFilters.join(' AND ');

    // ORDER BY: relevance when FTS, otherwise dateAdded
    const orderExpr =
      options.sortBy === 'year'
        ? `year ${options.sortOrder === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, id DESC`
        : options.sortBy === 'title'
          ? `title ${options.sortOrder === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, id DESC`
          : options.sortBy === 'relevance' || !options.sortBy
            ? `ts_rank(search_vector, plainto_tsquery('english', $2)) DESC, created_at DESC, id DESC`
            : `created_at ${options.sortOrder === 'asc' ? 'ASC' : 'DESC'}, id DESC`;

    let cursorCte = '';
    let cursorFilter = '';
    if (options.cursor) {
      const cursorParam = paramIdx++;
      params.push(options.cursor);
      cursorCte = `, cursor_pos AS (
        SELECT _row_num FROM search_results WHERE id = $${cursorParam}::uuid
      )`;
      cursorFilter = `WHERE _row_num > COALESCE((SELECT _row_num FROM cursor_pos), 0)`;
    }

    params.push(limit + 1);
    const limitParam = paramIdx++;

    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `WITH search_results AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ${orderExpr}) AS _row_num
         FROM "items"
         WHERE ${whereClause}
       )${cursorCte}
       SELECT id FROM search_results
       ${cursorFilter}
       ORDER BY _row_num ASC
       LIMIT $${limitParam}`,
      ...params,
    );

    let hasNextPage = false;
    let nextCursor: string | undefined;
    const ids = rows.map((r: any) => r.id as string);

    if (ids.length > limit) {
      hasNextPage = true;
      ids.pop();
      nextCursor = ids[ids.length - 1];
    }

    if (ids.length === 0) {
      return { items: [], nextCursor: undefined, hasNextPage: false };
    }

    // Fetch full records with relations in original ranked order
    const client = this.getClient(tx);
    const items = await client.item.findMany({
      where: { id: { in: ids } },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { take: 5 },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
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

    const items = await client.item.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        attachments: { take: 5 },
        itemTags: { include: { tag: true } },
        collectionItems: { include: { collection: true } },
      },
    });

    let hasNextPage = false;
    let nextCursor: string | undefined;

    if (items.length > limit) {
      hasNextPage = true;
      items.pop();
      nextCursor = items[items.length - 1]?.id;
    }

    return { items, nextCursor, hasNextPage };
  }

  async computeFacets(
    userId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<FacetResult> {
    // 1. Check Facet Cache (Cache-Aside)
    const scopeKey = options.projectId
      ? `proj:${options.projectId}`
      : `user:${userId}`;
    const filterHash = createHash('md5')
      .update(JSON.stringify(options))
      .digest('hex');
    const cacheKey = `library:search:facets:${scopeKey}:${filterHash}`;

    if (this.cache) {
      try {
        const cached = await this.cache.get<FacetResult>(cacheKey);
        if (cached) {
          return cached;
        }
      } catch (err: any) {
        this.logger.debug(`Facet cache lookup error: ${err?.message}`);
      }
    }

    const client = this.getClient(tx);
    const spec = SearchSpecificationBuilder.fromOptions(userId, options);
    const where = spec.toPrismaWhere();

    // 2. High-Performance Database Pushdown Aggregation (PostgreSQL engine groupBy)
    let facetResult: FacetResult;
    if (typeof (client.item as any)?.groupBy === 'function') {
      try {
        const [typeGroups, yearGroups, tagItems] = await Promise.all([
          (client.item as any).groupBy({
            by: ['itemType'],
            where,
            _count: { _all: true },
          }),
          (client.item as any).groupBy({
            by: ['year'],
            where,
            _count: { _all: true },
          }),
          typeof (client as any).itemTag?.findMany === 'function'
            ? (client as any).itemTag.findMany({
                where: { item: where },
                take: 1000,
                select: { tag: { select: { name: true } } },
              })
            : Promise.resolve([]),
        ]);

        const itemTypes: Record<string, number> = {};
        for (const g of typeGroups || []) {
          if (g.itemType) {
            itemTypes[g.itemType] =
              g._count?._all ?? g._count?.id ?? Number(g._count) ?? 1;
          }
        }

        const years: Record<number, number> = {};
        for (const g of yearGroups || []) {
          if (g.year != null) {
            years[Number(g.year)] =
              g._count?._all ?? g._count?.id ?? Number(g._count) ?? 1;
          }
        }

        const tags: Record<string, number> = {};
        for (const t of tagItems || []) {
          const tagName = t?.tag?.name;
          if (tagName) {
            tags[tagName] = (tags[tagName] || 0) + 1;
          }
        }

        facetResult = { itemTypes, years, tags };
      } catch (pushdownErr: any) {
        this.logger.debug(
          `GroupBy pushdown aggregation fallback to scan: ${pushdownErr?.message}`,
        );
        facetResult = await this.computeFacetsFallback(client, where);
      }
    } else {
      facetResult = await this.computeFacetsFallback(client, where);
    }

    // 3. Cache computed facet result (TTL: 120 seconds)
    if (this.cache) {
      try {
        await this.cache.set(cacheKey, facetResult, 120);
      } catch (err: any) {
        this.logger.debug(`Facet cache set error: ${err?.message}`);
      }
    }

    return facetResult;
  }

  private async computeFacetsFallback(
    client: any,
    where: Prisma.ItemWhereInput,
  ): Promise<FacetResult> {
    const items = await client.item.findMany({
      where,
      take: 2000,
      select: {
        itemType: true,
        year: true,
        itemTags: {
          take: 10,
          select: {
            tag: { select: { name: true } },
          },
        },
      },
    });

    const itemTypes: Record<string, number> = {};
    const years: Record<number, number> = {};
    const tags: Record<string, number> = {};

    for (const item of items) {
      if (item.itemType) {
        itemTypes[item.itemType] = (itemTypes[item.itemType] || 0) + 1;
      }
      if (item.year) {
        years[item.year] = (years[item.year] || 0) + 1;
      }
      for (const t of item.itemTags ?? []) {
        if (t.tag?.name) {
          tags[t.tag.name] = (tags[t.tag.name] || 0) + 1;
        }
      }
    }

    return { itemTypes, years, tags };
  }

  async invalidateFacets(scopeId: string): Promise<void> {
    if (this.cache) {
      await this.cache.delPattern(`library:search:facets:*${scopeId}*`);
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
      const res: any[] = await this.prisma.$queryRaw`
        SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'papers'
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
          'PostgreSQL FTS: search_vector column not found on table "papers" — run migration "add_catalog_item_fts" to enable. Falling back to ILIKE.',
        );
      }
    } catch (err: any) {
      this.ftsColumnExists = false;
      this.logger.warn(
        `PostgreSQL FTS: search_vector column check failed (${err?.message}) — falling back to ILIKE.`,
      );
    }
  }

  // ── Project Scope Operations ─────────────────────────────────────────────
  async checkProjectMember(projectId: string, userId: string) {
    return this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId, userId },
      },
      select: { role: true },
    });
  }


  // ── Search Attachment Anchor Operations ──────────────────────────────────
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

  // ── EventHandler Index Cleanup Operations ────────────────────────────────
  async deleteFullTextIndexByItemId(itemId: string): Promise<void> {
    const attachments = await this.prisma.attachment.findMany({
      where: { itemId },
      select: { id: true },
    });

    for (const att of attachments) {
      await this.prisma.fullTextIndex.deleteMany({
        where: { attachmentId: att.id },
      });
    }
  }

  async deleteFullTextIndexByAttachmentId(attachmentId: string): Promise<void> {
    await this.prisma.fullTextIndex.deleteMany({
      where: { attachmentId },
    });
  }
}
