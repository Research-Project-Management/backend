import { createHash } from 'crypto';
import { isUUID } from 'class-validator';
import {
  SearchOptions,
  FacetResult,
} from '@/modules/library/search/types/search.types';
import { isProjectScopeId } from '@/modules/library/core';
import { extractSearchQueryIdentifiers } from '@/modules/library/search/domain/item-specifications';

export const isValidUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

export function sanitizeUuidSearchOptions(
  options: SearchOptions,
): SearchOptions {
  return {
    ...options,
    ...(options.projectId !== undefined
      ? {
          projectId:
            isProjectScopeId(options.projectId) &&
            isValidUuid(options.projectId.trim())
              ? options.projectId.trim()
              : undefined,
        }
      : {}),
    ...(options.collectionId !== undefined
      ? {
          collectionId: isValidUuid(options.collectionId)
            ? options.collectionId
            : undefined,
        }
      : {}),
    ...(options.tagId !== undefined
      ? {
          tagId: isValidUuid(options.tagId) ? options.tagId : undefined,
        }
      : {}),
    ...(options.cursor !== undefined
      ? {
          cursor: isValidUuid(options.cursor) ? options.cursor : undefined,
        }
      : {}),
  };
}

export function buildSearchItemsCacheKey(
  userId: string,
  options: SearchOptions,
  queryText: string | undefined,
  limit: number,
): string {
  const scopeKey = isProjectScopeId(options.projectId)
    ? `proj:${options.projectId}:u:${userId}`
    : `user:${userId}`;
  const normalizedCacheInput = {
    userId,
    q: queryText || '',
    cursor: options.cursor || '',
    limit,
    projectId: options.projectId || '',
    collectionId: options.collectionId || '',
    tagId: options.tagId || '',
    itemType: Array.isArray(options.itemType)
      ? [...options.itemType].sort()
      : options.itemType || '',
    yearFrom: options.yearFrom ?? null,
    yearTo: options.yearTo ?? null,
    sortBy: options.sortBy || '',
    sortOrder: options.sortOrder || '',
  };
  const filterHash = createHash('sha256')
    .update(JSON.stringify(normalizedCacheInput))
    .digest('hex');
  return `library:search:items:${scopeKey}:${filterHash}`;
}

export function buildSearchFacetCacheKey(
  userId: string,
  options: SearchOptions,
): string {
  const sanitized = sanitizeUuidSearchOptions(options);
  const scopeKey = isProjectScopeId(sanitized.projectId)
    ? `proj:${sanitized.projectId}`
    : `user:${userId}`;
  const filterHash = createHash('md5')
    .update(
      JSON.stringify({
        q: sanitized.q?.trim() || '',
        projectId: sanitized.projectId,
        collectionId: sanitized.collectionId,
        tagId: sanitized.tagId,
        itemType: sanitized.itemType,
        yearFrom: sanitized.yearFrom,
        yearTo: sanitized.yearTo,
      }),
    )
    .digest('hex');
  return `library:search:facets:${scopeKey}:${filterHash}`;
}

export function aggregateFacetGroups(params: {
  typeGroups: Array<{ itemType?: string | null; _count?: { _all?: number } }>;
  yearGroups: Array<{ year?: number | null; _count?: { _all?: number } }>;
  tagItems: Array<{ tag?: { name?: string | null } | null }>;
}): FacetResult {
  const itemTypes: Record<string, number> = {};
  for (const g of params.typeGroups || []) {
    if (g.itemType) {
      itemTypes[g.itemType] = g._count?._all ?? 1;
    }
  }

  const years: Record<number, number> = {};
  for (const g of params.yearGroups || []) {
    if (g.year != null) {
      years[Number(g.year)] = g._count?._all ?? 1;
    }
  }

  const tags: Record<string, number> = {};
  for (const t of params.tagItems || []) {
    const tagName = t?.tag?.name;
    if (tagName) {
      tags[tagName] = (tags[tagName] || 0) + 1;
    }
  }

  return { itemTypes, years, tags };
}

export function buildSearchFtsMatchingIdsSql(params: {
  userId: string;
  options: SearchOptions;
  queryText: string;
  limit?: number;
}): { sql: string; params: unknown[] } | null {
  const { userId, options, queryText, limit = 5000 } = params;
  const hasProject = isProjectScopeId(options.projectId);
  const scopeParamVal = hasProject ? options.projectId!.trim() : userId;
  if (!isValidUuid(scopeParamVal)) {
    return null;
  }

  const rawQuery = options.q?.trim() || queryText;
  const ids = extractSearchQueryIdentifiers(rawQuery);
  const sqlParams: unknown[] = [scopeParamVal, queryText];
  let paramIdx = 3;

  const textOrClauses: string[] = [
    `search_vector @@ plainto_tsquery('english', $2)`,
    `EXISTS (SELECT 1 FROM "attachments" a JOIN "full_text_index" fti ON fti.attachment_id = a.id WHERE a.item_id = "items".id AND a.deleted_at IS NULL AND to_tsvector('english', COALESCE(fti.text_content, '')) @@ plainto_tsquery('english', $2))`,
  ];

  if (ids.cleanDoi) {
    textOrClauses.push(`LOWER(COALESCE(doi, '')) LIKE $${paramIdx++}`);
    sqlParams.push(`%${ids.cleanDoi.toLowerCase()}%`);
  }
  if (ids.cleanIsbn) {
    textOrClauses.push(`COALESCE(metadata->>'isbn', '') LIKE $${paramIdx++}`);
    sqlParams.push(`%${ids.cleanIsbn}%`);
  }
  if (ids.cleanArxivBase || ids.cleanArxiv) {
    textOrClauses.push(
      `LOWER(COALESCE(metadata->>'arxivId', '')) LIKE $${paramIdx++}`,
    );
    sqlParams.push(`%${(ids.cleanArxivBase || ids.cleanArxiv)!.toLowerCase()}%`);
  }
  if (ids.cleanPmid) {
    textOrClauses.push(`COALESCE(metadata->>'pmid', '') LIKE $${paramIdx++}`);
    sqlParams.push(`%${ids.cleanPmid}%`);
  }
  if (ids.cleanPmcid) {
    textOrClauses.push(
      `UPPER(COALESCE(metadata->>'pmcid', '')) LIKE $${paramIdx++}`,
    );
    sqlParams.push(`%${ids.cleanPmcid.toUpperCase()}%`);
  }
  if (ids.cleanIssn) {
    textOrClauses.push(
      `UPPER(COALESCE(metadata->>'issn', '')) LIKE $${paramIdx++}`,
    );
    sqlParams.push(`%${ids.cleanIssn.toUpperCase()}%`);
  }

  const scopeSql = hasProject
    ? `project_id = $1::uuid`
    : `user_id = $1::uuid AND project_id IS NULL`;

  const sql = `SELECT id FROM "items" WHERE ${scopeSql} AND deleted_at IS NULL AND (${textOrClauses.join(' OR ')}) LIMIT ${Math.max(1, Math.floor(limit))}`;
  return { sql, params: sqlParams };
}

export function buildSearchFtsSqlQuery(params: {
  userId: string;
  options: SearchOptions;
  queryText: string;
  limit: number;
}): { sql: string; params: unknown[] } | null {
  const { userId, options, queryText, limit } = params;
  const hasProject = isProjectScopeId(options.projectId);
  const scopeParamVal = hasProject ? options.projectId!.trim() : userId;
  if (!isValidUuid(scopeParamVal)) {
    return null;
  }

  const rawQuery = options.q?.trim() || queryText;
  const ids = extractSearchQueryIdentifiers(rawQuery);
  const sqlParams: unknown[] = [scopeParamVal, queryText];
  let paramIdx = 3;

  const textOrClauses: string[] = [
    `search_vector @@ plainto_tsquery('english', $2)`,
    `EXISTS (SELECT 1 FROM "attachments" a JOIN "full_text_index" fti ON fti.attachment_id = a.id WHERE a.item_id = "items".id AND a.deleted_at IS NULL AND to_tsvector('english', COALESCE(fti.text_content, '')) @@ plainto_tsquery('english', $2))`,
  ];

  if (ids.cleanDoi) {
    textOrClauses.push(`LOWER(COALESCE(doi, '')) LIKE $${paramIdx++}`);
    sqlParams.push(`%${ids.cleanDoi.toLowerCase()}%`);
  }
  if (ids.cleanIsbn) {
    textOrClauses.push(`COALESCE(metadata->>'isbn', '') LIKE $${paramIdx++}`);
    sqlParams.push(`%${ids.cleanIsbn}%`);
  }
  if (ids.cleanArxivBase || ids.cleanArxiv) {
    textOrClauses.push(
      `LOWER(COALESCE(metadata->>'arxivId', '')) LIKE $${paramIdx++}`,
    );
    sqlParams.push(`%${(ids.cleanArxivBase || ids.cleanArxiv)!.toLowerCase()}%`);
  }
  if (ids.cleanPmid) {
    textOrClauses.push(`COALESCE(metadata->>'pmid', '') LIKE $${paramIdx++}`);
    sqlParams.push(`%${ids.cleanPmid}%`);
  }
  if (ids.cleanPmcid) {
    textOrClauses.push(
      `UPPER(COALESCE(metadata->>'pmcid', '')) LIKE $${paramIdx++}`,
    );
    sqlParams.push(`%${ids.cleanPmcid.toUpperCase()}%`);
  }
  if (ids.cleanIssn) {
    textOrClauses.push(
      `UPPER(COALESCE(metadata->>'issn', '')) LIKE $${paramIdx++}`,
    );
    sqlParams.push(`%${ids.cleanIssn.toUpperCase()}%`);
  }

  const baseFilters: string[] = [
    hasProject
      ? `project_id = $1::uuid`
      : `user_id = $1::uuid AND project_id IS NULL`,
    `deleted_at IS NULL`,
    `(${textOrClauses.join(' OR ')})`,
  ];

  if (options.itemType) {
    if (Array.isArray(options.itemType)) {
      if (options.itemType.length === 1) {
        baseFilters.push(`"type" = $${paramIdx++}`);
        sqlParams.push(options.itemType[0]);
      } else if (options.itemType.length > 1) {
        baseFilters.push(`"type" = ANY($${paramIdx++}::text[])`);
        sqlParams.push(options.itemType);
      }
    } else {
      baseFilters.push(`"type" = $${paramIdx++}`);
      sqlParams.push(options.itemType);
    }
  }
  if (options.yearFrom) {
    baseFilters.push(`year >= $${paramIdx++}`);
    sqlParams.push(options.yearFrom);
  }
  if (options.yearTo) {
    baseFilters.push(`year <= $${paramIdx++}`);
    sqlParams.push(options.yearTo);
  }
  if (options.collectionId) {
    if (!isValidUuid(options.collectionId)) {
      return null;
    }
    baseFilters.push(
      `EXISTS (SELECT 1 FROM "collection_items" ci WHERE ci.item_id = "items".id AND ci.collection_id = $${paramIdx++}::uuid)`,
    );
    sqlParams.push(options.collectionId);
  }
  if (options.tagId) {
    if (!isValidUuid(options.tagId)) {
      return null;
    }
    baseFilters.push(
      `EXISTS (SELECT 1 FROM "item_tags" it WHERE it.item_id = "items".id AND it.tag_id = $${paramIdx++}::uuid)`,
    );
    sqlParams.push(options.tagId);
  }

  const whereClause = baseFilters.join(' AND ');
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
    if (!isValidUuid(options.cursor)) {
      return null;
    }
    const cursorParam = paramIdx++;
    sqlParams.push(options.cursor);
    cursorCte = `, cursor_pos AS (
        SELECT _row_num FROM search_results WHERE id = $${cursorParam}::uuid
      )`;
    cursorFilter = `WHERE EXISTS (SELECT 1 FROM cursor_pos) AND _row_num > (SELECT _row_num FROM cursor_pos)`;
  }

  sqlParams.push(limit + 1);
  const limitParam = paramIdx++;

  const sql = `WITH search_results AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ${orderExpr}) AS _row_num
         FROM "items"
         WHERE ${whereClause}
       )${cursorCte}
       SELECT id FROM search_results
       ${cursorFilter}
       ORDER BY _row_num ASC
       LIMIT $${limitParam}`;

  return { sql, params: sqlParams };
}
