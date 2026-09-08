import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { Prisma } from '@prisma/client';

import { SearchOptions, FacetResult } from './types/search.types';
import { buildBaseSearchWhere } from './utils/search.utils';

export { SearchOptions, FacetResult };

@Injectable()
export class SearchRepository implements OnModuleInit {
  private readonly logger = new Logger(SearchRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.checkFtsColumnExists();
  }

  private getClient(tx?: Prisma.TransactionClient) {
    return tx || this.prisma;
  }

  /**
   * Builds the base Prisma WHERE clause for non-text filters.
   * Text search is handled separately via raw FTS or ILIKE fallback.
   */
  private buildBaseWhere(
    workspaceId: string,
    options: SearchOptions,
  ): Prisma.CatalogItemWhereInput {
    return buildBaseSearchWhere(workspaceId, options);
  }

  /**
   * Builds a Prisma text-search OR clause using ILIKE.
   * Used as fallback when tsvector is not available.
   */
  private buildTextWhereIlike(q: string): Prisma.CatalogItemWhereInput {
    const trimmed = q.trim();
    return {
      OR: [
        { title: { contains: trimmed, mode: 'insensitive' } },
        { abstract: { contains: trimmed, mode: 'insensitive' } },
        { doi: { contains: trimmed, mode: 'insensitive' } },
        { citationKey: { contains: trimmed, mode: 'insensitive' } },
        { publicationTitle: { contains: trimmed, mode: 'insensitive' } },
        {
          contributors: {
            some: {
              OR: [
                { fullName: { contains: trimmed, mode: 'insensitive' } },
                { lastName: { contains: trimmed, mode: 'insensitive' } },
              ],
            },
          },
        },
      ],
    };
  }

  async searchItems(
    workspaceId: string,
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
        return await this.searchItemsFts(workspaceId, options, q, limit, tx);
      } catch (err: any) {
        // Column might not exist yet (pre-migration) — fall through to ILIKE
        this.logger.warn(
          `FTS query failed, falling back to ILIKE: ${err?.message}`,
        );
      }
    }
    // ── ILIKE fallback (pre-migration or no text query) ────────────────────
    return await this.searchItemsIlike(workspaceId, options, limit, tx);
  }

  private async searchItemsFts(
    workspaceId: string,
    options: SearchOptions,
    q: string,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    // Build structured filters as SQL fragment
    const baseFilters: string[] = [
      `workspace_id = $1::uuid`,
      `deleted_at IS NULL`,
      `search_vector @@ plainto_tsquery('english', $2)`,
    ];
    const params: any[] = [workspaceId, q];
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
        `EXISTS (SELECT 1 FROM "collection_items" ci WHERE ci.catalog_item_id = "papers".id AND ci.collection_id = $${paramIdx++}::uuid)`,
      );
      params.push(options.collectionId);
    }
    if (options.tagId) {
      baseFilters.push(
        `EXISTS (SELECT 1 FROM "catalog_item_tags" it WHERE it.catalog_item_id = "papers".id AND it.tag_id = $${paramIdx++}::uuid)`,
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
         FROM "papers"
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
    const items = await client.catalogItem.findMany({
      where: { id: { in: ids } },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
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
    workspaceId: string,
    options: SearchOptions,
    limit: number,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    const q = options.q?.trim();

    const where: Prisma.CatalogItemWhereInput = {
      ...this.buildBaseWhere(workspaceId, options),
      ...(q ? this.buildTextWhereIlike(q) : {}),
    };

    const orderBy: Prisma.CatalogItemOrderByWithRelationInput =
      options.sortBy === 'year'
        ? { year: options.sortOrder || 'desc' }
        : options.sortBy === 'title'
          ? { title: options.sortOrder || 'asc' }
          : { createdAt: options.sortOrder || 'desc' };

    const items = await client.catalogItem.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
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
    workspaceId: string,
    options: SearchOptions,
    tx?: Prisma.TransactionClient,
  ): Promise<FacetResult> {
    const client = this.getClient(tx);

    // Use the same text where logic as ILIKE for facets (FTS facets are computed same way)
    const q = options.q?.trim();
    const where: Prisma.CatalogItemWhereInput = {
      ...this.buildBaseWhere(workspaceId, options),
      ...(q ? this.buildTextWhereIlike(q) : {}),
    };

    // Limit facet sampling to top 2,000 matches to prevent OOM on massive libraries
    const items = await client.catalogItem.findMany({
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
      for (const t of item.itemTags) {
        if (t.tag?.name) {
          tags[t.tag.name] = (tags[t.tag.name] || 0) + 1;
        }
      }
    }

    return { itemTypes, years, tags };
  }

  /**
   * Checks if the search_vector FTS column exists on CatalogItem.
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
}
