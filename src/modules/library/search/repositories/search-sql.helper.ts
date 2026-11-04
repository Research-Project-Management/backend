import { createHash } from 'crypto';
import { isUuid as isValidUuid } from '@/core';
import {
  SearchOptions,
  FacetResult,
} from '@/modules/library/search/controllers/search.controller';
import {
  isProjectScopeId,
  LIBRARY_REDIS_KEYS,
  SearchQueryEngine,
  collectDescendantCollectionIds,
  normalizeCanonicalItemType,
} from '@/modules/library/core';
import { extractSearchQueryIdentifiers } from '@/modules/library/search/domain/item-specifications';

export { isValidUuid };

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
    ...(options.collectionIds !== undefined
      ? {
          collectionIds: Array.isArray(options.collectionIds)
            ? options.collectionIds.filter(isValidUuid)
            : undefined,
        }
      : {}),
    ...(options.targetCollectionIds !== undefined
      ? {
          targetCollectionIds: Array.isArray(options.targetCollectionIds)
            ? options.targetCollectionIds.filter(isValidUuid)
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

export async function resolveSearchCollectionOptions(
  client: {
    collection?: {
      findMany?: (args: {
        where: Record<string, unknown>;
        select: { id: true; parentId: true };
      }) => Promise<Array<{ id: string; parentId: string | null }>>;
    };
  },
  userId: string,
  options: SearchOptions,
): Promise<SearchOptions> {
  if (
    !options.collectionId ||
    !isValidUuid(options.collectionId) ||
    (options.collectionIds && options.collectionIds.length > 0) ||
    options.includeSubcollections === false ||
    options.recursive === false ||
    typeof client?.collection?.findMany !== 'function'
  ) {
    return options;
  }

  try {
    const hasProject =
      isProjectScopeId(options.projectId) &&
      isValidUuid(options.projectId.trim());
    const collections = await client.collection.findMany({
      where: {
        deletedAt: null,
        ...(hasProject
          ? { projectId: options.projectId!.trim() }
          : { userId, projectId: null }),
      },
      select: { id: true, parentId: true },
    });
    if (!Array.isArray(collections) || collections.length === 0) {
      return options;
    }

    const descendants = collectDescendantCollectionIds(
      collections,
      options.collectionId,
    );
    if (descendants.length > 0) {
      return {
        ...options,
        collectionIds: [options.collectionId, ...descendants],
      };
    }
    return {
      ...options,
      collectionIds: [options.collectionId],
    };
  } catch {
    // Non-fatal: keep direct collectionId filter if hierarchy lookup fails
  }

  return options;
}

export function buildSearchItemsCacheKey(
  userId: string,
  options: SearchOptions,
  queryText: string | undefined,
  limit: number,
  version: string = '1',
): string {
  const scopeKey = isProjectScopeId(options.projectId)
    ? `proj:${options.projectId}:u:${userId}`
    : `user:${userId}`;
  const effectiveType = options.itemType || options.type || '';
  const normalizedCacheInput = {
    userId,
    q: queryText || '',
    searchMode: options.searchMode || '',
    view: options.view || '',
    cursor: options.cursor || '',
    page: options.page ?? 1,
    limit,
    projectId: options.projectId || '',
    collectionId: options.collectionId || '',
    targetCollectionIds: Array.isArray(options.targetCollectionIds)
      ? [...options.targetCollectionIds].filter(isValidUuid).sort()
      : [],
    includeSubcollections: options.includeSubcollections ?? true,
    tagId: options.tagId || '',
    tag: options.tag || '',
    hasFile: options.hasFile ?? null,
    hasNotes: options.hasNotes ?? null,
    isRetracted: options.isRetracted ?? null,
    onlyFlagged: options.onlyFlagged ?? null,
    readStatus: options.readStatus || '',
    itemType: Array.isArray(effectiveType)
      ? [...effectiveType].sort()
      : effectiveType,
    yearFrom: options.yearFrom ?? options.fromYear ?? null,
    yearTo: options.yearTo ?? options.toYear ?? null,
    sortBy: options.sortBy || options.orderBy || '',
    sortOrder: options.sortOrder || options.orderDirection || '',
    version,
  };
  const filterHash = createHash('sha256')
    .update(JSON.stringify(normalizedCacheInput))
    .digest('hex');
  return LIBRARY_REDIS_KEYS.searchItems(scopeKey, version, filterHash);
}

export function buildSearchFacetCacheKey(
  userId: string,
  options: SearchOptions,
  version: string = '1',
): string {
  const sanitized = sanitizeUuidSearchOptions(options);
  const scopeKey = isProjectScopeId(sanitized.projectId)
    ? `proj:${sanitized.projectId}`
    : `user:${userId}`;
  const filterHash = createHash('sha256')
    .update(
      JSON.stringify({
        q: sanitized.q?.trim() || '',
        searchMode: sanitized.searchMode || '',
        view: sanitized.view || '',
        projectId: sanitized.projectId,
        collectionId: sanitized.collectionId,
        targetCollectionIds: Array.isArray(sanitized.targetCollectionIds)
          ? [...sanitized.targetCollectionIds].sort()
          : [],
        includeSubcollections: sanitized.includeSubcollections ?? true,
        tagId: sanitized.tagId,
        tag: sanitized.tag || '',
        hasFile: sanitized.hasFile ?? null,
        hasNotes: sanitized.hasNotes ?? null,
        isRetracted: sanitized.isRetracted ?? null,
        onlyFlagged: sanitized.onlyFlagged ?? null,
        readStatus: sanitized.readStatus || '',
        itemType: sanitized.itemType || sanitized.type,
        yearFrom: sanitized.yearFrom ?? sanitized.fromYear,
        yearTo: sanitized.yearTo ?? sanitized.toYear,
        version,
      }),
    )
    .digest('hex');
  return LIBRARY_REDIS_KEYS.searchFacets(scopeKey, version, filterHash);
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

export function escapeLikePattern(val: string): string {
  return val.replace(/[%_\\]/g, '\\$&');
}

const ITEM_FTS_VECTOR_SQL = `COALESCE(search_vector, setweight(to_tsvector('english', COALESCE(title, '')), 'A') || setweight(to_tsvector('english', COALESCE(abstract, '')), 'B') || setweight(to_tsvector('english', COALESCE(publication_title, '')), 'C'))`;

export function buildFtsWhereClause(params: {
  hasProject: boolean;
  userId?: string;
  options: SearchOptions;
  queryText: string;
}): {
  whereClause: string;
  sqlParams: unknown[];
  nextParamIdx: number;
  tsQuerySqlExpr: string;
} | null {
  const { hasProject, userId, options, queryText } = params;
  const rawQuery = options.q?.trim() || queryText;
  const ids = extractSearchQueryIdentifiers(rawQuery);
  const escapedLikeQuery = escapeLikePattern(queryText);
  const sqlParams: unknown[] = [queryText, escapedLikeQuery];
  let paramIdx = 4;

  const tsQuerySqlExpr = `plainto_tsquery('english', $2)`;

  const searchMode =
    options.searchMode === 'title_creator_year'
      ? 'title_creator_year'
      : options.searchMode === 'fields_tags'
        ? 'fields_tags'
        : 'everything';

  const textOrClauses: string[] = [];

  if (searchMode === 'title_creator_year') {
    const titleCreatorFtsVector = `(setweight(to_tsvector('english', COALESCE(title, '')), 'A') || setweight(to_tsvector('simple', COALESCE(first_author, '')), 'B'))`;
    textOrClauses.push(
      `${titleCreatorFtsVector} @@ ${tsQuerySqlExpr}`,
      `LOWER(COALESCE(title, '')) LIKE ('%' || LOWER($3) || '%')`,
      `EXISTS (SELECT 1 FROM "contributors" c WHERE c.item_id = "items".id AND (LOWER(COALESCE(c.full_name, '')) LIKE ('%' || LOWER($3) || '%') OR LOWER(COALESCE(c.last_name, '')) LIKE ('%' || LOWER($3) || '%')))`,
    );
    if (/^\d{4}$/.test(rawQuery)) {
      const yearIdx = paramIdx++;
      sqlParams.push(Number(rawQuery));
      textOrClauses.push(`year = $${yearIdx}`);
    }
  } else {
    textOrClauses.push(
      `${ITEM_FTS_VECTOR_SQL} @@ ${tsQuerySqlExpr}`,
      `LOWER(COALESCE(title, '')) LIKE ('%' || LOWER($3) || '%')`,
      `LOWER(COALESCE(citation_key, '')) LIKE ('%' || LOWER($3) || '%')`,
      `EXISTS (SELECT 1 FROM "contributors" c WHERE c.item_id = "items".id AND (LOWER(COALESCE(c.full_name, '')) LIKE ('%' || LOWER($3) || '%') OR LOWER(COALESCE(c.last_name, '')) LIKE ('%' || LOWER($3) || '%')))`,
      `EXISTS (SELECT 1 FROM "item_tags" it JOIN "tags" t ON t.id = it.tag_id WHERE it.item_id = "items".id AND LOWER(t.name) LIKE ('%' || LOWER($3) || '%'))`,
    );

    if (searchMode === 'everything') {
      textOrClauses.push(
        `EXISTS (SELECT 1 FROM "notes" n WHERE n.item_id = "items".id AND n.deleted_at IS NULL AND (LOWER(COALESCE(n.title, '')) LIKE ('%' || LOWER($3) || '%') OR LOWER(COALESCE(n.content_md, '')) LIKE ('%' || LOWER($3) || '%')))`,
        `EXISTS (SELECT 1 FROM "attachments" a JOIN "full_text_indexes" fti ON fti.attachment_id = a.id WHERE a.item_id = "items".id AND a.deleted_at IS NULL AND (COALESCE(fti.search_vector, to_tsvector('english', COALESCE(fti.text_content, ''))) @@ ${tsQuerySqlExpr} OR fti.text_content ILIKE ('%' || $3 || '%')))`,
      );
    }

    const pushIdentifierMatch = (
      jsonOrColExpr: string,
      likeVal: string,
      identType?: string,
    ) => {
      const pIdx = paramIdx++;
      sqlParams.push(likeVal);
      if (identType) {
        const typeIdx = paramIdx++;
        sqlParams.push(identType);
        textOrClauses.push(
          `(${jsonOrColExpr} LIKE $${pIdx} OR EXISTS (SELECT 1 FROM "item_identifiers" ii WHERE ii."item_id" = "items"."id" AND LOWER(ii."type") = $${typeIdx} AND LOWER(ii."value") LIKE LOWER($${pIdx})))`,
        );
      } else {
        textOrClauses.push(
          `(${jsonOrColExpr} LIKE $${pIdx} OR EXISTS (SELECT 1 FROM "item_identifiers" ii WHERE ii."item_id" = "items"."id" AND LOWER(ii."value") LIKE LOWER($${pIdx})))`,
        );
      }
    };

    if (ids.cleanDoi) {
      pushIdentifierMatch(
        `LOWER(COALESCE(doi, ''))`,
        `%${escapeLikePattern(ids.cleanDoi.toLowerCase())}%`,
        'doi',
      );
    }
    if (ids.cleanIsbn) {
      pushIdentifierMatch(
        `COALESCE(metadata->>'isbn', '')`,
        `%${escapeLikePattern(ids.cleanIsbn)}%`,
        'isbn',
      );
    }
    if (ids.cleanArxivBase || ids.cleanArxiv) {
      pushIdentifierMatch(
        `LOWER(COALESCE(metadata->>'arxivId', ''))`,
        `%${escapeLikePattern((ids.cleanArxivBase || ids.cleanArxiv)!.toLowerCase())}%`,
        'arxiv',
      );
    }
    if (ids.cleanPmid) {
      pushIdentifierMatch(
        `COALESCE(metadata->>'pmid', '')`,
        `%${escapeLikePattern(ids.cleanPmid)}%`,
        'pmid',
      );
    }
    if (ids.cleanPmcid) {
      pushIdentifierMatch(
        `UPPER(COALESCE(metadata->>'pmcid', ''))`,
        `%${escapeLikePattern(ids.cleanPmcid.toUpperCase())}%`,
        'pmcid',
      );
    }
    if (ids.cleanIssn) {
      pushIdentifierMatch(
        `UPPER(COALESCE(metadata->>'issn', ''))`,
        `%${escapeLikePattern(ids.cleanIssn.toUpperCase())}%`,
        'issn',
      );
    }
  }

  const view = options.view ?? 'all';
  const baseFilters: string[] = [
    hasProject
      ? `project_id = $1::uuid`
      : `user_id = $1::uuid AND project_id IS NULL`,
    view === 'trash' ? `deleted_at IS NOT NULL` : `deleted_at IS NULL`,
    `(${textOrClauses.join(' OR ')})`,
  ];

  let userParamRef: string | null = !hasProject ? `$1::uuid` : null;
  const ensureUserParamRef = (): string | null => {
    if (userParamRef) return userParamRef;
    if (userId && isValidUuid(userId)) {
      const idx = paramIdx++;
      sqlParams.push(userId);
      userParamRef = `$${idx}::uuid`;
      return userParamRef;
    }
    return null;
  };

  if (view === 'unfiled') {
    baseFilters.push(
      `NOT EXISTS (SELECT 1 FROM "collection_items" ci JOIN "collections" c ON c.id = ci.collection_id AND c.deleted_at IS NULL WHERE ci.item_id = "items".id)`,
    );
  } else if (view === 'starred') {
    const uRef = ensureUserParamRef();
    if (uRef) {
      baseFilters.push(
        `EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef} AND s.is_starred = true)`,
      );
    }
  } else if (view === 'my-publications' || view === 'publications') {
    const uRef = ensureUserParamRef();
    if (uRef) {
      baseFilters.push(
        `(COALESCE(metadata->>'isMyPublication', 'false') = 'true' OR EXISTS (SELECT 1 FROM "publications" p WHERE p.item_id = "items".id AND p.user_id = ${uRef}))`,
      );
    } else {
      baseFilters.push(
        `COALESCE(metadata->>'isMyPublication', 'false') = 'true'`,
      );
    }
  } else if (view === 'retracted') {
    baseFilters.push(
      `(is_retracted = true OR COALESCE(metadata->>'isRetracted', 'false') = 'true')`,
    );
  }

  const rawItemType = options.itemType || options.type;
  if (rawItemType) {
    const typeList = Array.from(
      new Set(
        (Array.isArray(rawItemType) ? rawItemType : [rawItemType])
          .flatMap((t) => String(t).split(','))
          .map((t) => normalizeCanonicalItemType(t))
          .filter(Boolean),
      ),
    );
    if (typeList.length === 1) {
      baseFilters.push(`"type" = $${paramIdx++}`);
      sqlParams.push(typeList[0]);
    } else if (typeList.length > 1) {
      baseFilters.push(`"type" = ANY($${paramIdx++}::text[])`);
      sqlParams.push(typeList);
    }
  }

  const effectiveYearFrom = options.yearFrom ?? options.fromYear;
  if (effectiveYearFrom !== undefined && effectiveYearFrom !== null) {
    baseFilters.push(`year >= $${paramIdx++}`);
    sqlParams.push(effectiveYearFrom);
  }
  const effectiveYearTo = options.yearTo ?? options.toYear;
  if (effectiveYearTo !== undefined && effectiveYearTo !== null) {
    baseFilters.push(`year <= $${paramIdx++}`);
    sqlParams.push(effectiveYearTo);
  }

  if (options.hasFile !== undefined) {
    baseFilters.push(`has_file = $${paramIdx++}`);
    sqlParams.push(Boolean(options.hasFile));
  }

  if (options.hasNotes !== undefined) {
    baseFilters.push(options.hasNotes ? `note_count > 0` : `note_count = 0`);
  }

  if (options.isRetracted !== undefined) {
    baseFilters.push(
      options.isRetracted
        ? `(is_retracted = true OR COALESCE(metadata->>'isRetracted', 'false') = 'true')`
        : `(is_retracted = false AND COALESCE(metadata->>'isRetracted', 'false') != 'true')`,
    );
  }

  if (options.onlyFlagged === true) {
    const uRef = ensureUserParamRef();
    if (uRef) {
      baseFilters.push(
        `EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef} AND s.is_starred = true)`,
      );
    }
  }

  if (options.readStatus && options.readStatus !== 'all') {
    const validStatuses = ['unread', 'reading', 'completed'];
    const statuses = options.readStatus
      .split(',')
      .map((s) => (s.trim() === 'read' ? 'completed' : s.trim()))
      .filter((s) => validStatuses.includes(s));
    const uRef = ensureUserParamRef();
    if (statuses.length > 0 && uRef) {
      if (statuses.includes('unread')) {
        if (statuses.length === 1) {
          baseFilters.push(
            `(NOT EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef}) OR EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef} AND s.read_status::text = 'unread'))`,
          );
        } else {
          baseFilters.push(
            `(NOT EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef}) OR EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef} AND s.read_status::text = ANY($${paramIdx++}::text[])))`,
          );
          sqlParams.push(statuses);
        }
      } else if (statuses.length === 1) {
        baseFilters.push(
          `EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef} AND s.read_status::text = $${paramIdx++})`,
        );
        sqlParams.push(statuses[0]);
      } else {
        baseFilters.push(
          `EXISTS (SELECT 1 FROM "states" s WHERE s.item_id = "items".id AND s.user_id = ${uRef} AND s.read_status::text = ANY($${paramIdx++}::text[]))`,
        );
        sqlParams.push(statuses);
      }
    }
  }

  const rawCollectionIds =
    Array.isArray(options.collectionIds) && options.collectionIds.length > 0
      ? options.collectionIds
      : Array.isArray(options.targetCollectionIds)
        ? options.targetCollectionIds
        : [];
  const validCollectionIds = rawCollectionIds.filter(isValidUuid);
  if (validCollectionIds.length > 1) {
    baseFilters.push(
      `EXISTS (SELECT 1 FROM "collection_items" ci JOIN "collections" c ON c.id = ci.collection_id AND c.deleted_at IS NULL WHERE ci.item_id = "items".id AND ci.collection_id = ANY($${paramIdx++}::uuid[]))`,
    );
    sqlParams.push(validCollectionIds);
  } else if (validCollectionIds.length === 1) {
    baseFilters.push(
      `EXISTS (SELECT 1 FROM "collection_items" ci JOIN "collections" c ON c.id = ci.collection_id AND c.deleted_at IS NULL WHERE ci.item_id = "items".id AND ci.collection_id = $${paramIdx++}::uuid)`,
    );
    sqlParams.push(validCollectionIds[0]);
  } else if (options.collectionId) {
    if (!isValidUuid(options.collectionId)) {
      return null;
    }
    baseFilters.push(
      `EXISTS (SELECT 1 FROM "collection_items" ci JOIN "collections" c ON c.id = ci.collection_id AND c.deleted_at IS NULL WHERE ci.item_id = "items".id AND ci.collection_id = $${paramIdx++}::uuid)`,
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
  if (options.tag) {
    const tagNames = options.tag
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (tagNames.length === 1) {
      baseFilters.push(
        `EXISTS (SELECT 1 FROM "item_tags" it JOIN "tags" t ON t.id = it.tag_id WHERE it.item_id = "items".id AND LOWER(t.name) = $${paramIdx++})`,
      );
      sqlParams.push(tagNames[0]);
    } else if (tagNames.length > 1) {
      baseFilters.push(
        `EXISTS (SELECT 1 FROM "item_tags" it JOIN "tags" t ON t.id = it.tag_id WHERE it.item_id = "items".id AND LOWER(t.name) = ANY($${paramIdx++}::text[]))`,
      );
      sqlParams.push(tagNames);
    }
  }

  return {
    whereClause: baseFilters.join(' AND '),
    sqlParams,
    nextParamIdx: paramIdx,
    tsQuerySqlExpr,
  };
}

export function buildSearchFtsMatchingIdsSql(params: {
  userId: string;
  options: SearchOptions;
  queryText: string;
  limit?: number;
}): { sql: string; params: unknown[] } | null {
  const { userId, options, queryText, limit = 50000 } = params;
  const hasProject = isProjectScopeId(options.projectId);
  const scopeParamVal = hasProject ? options.projectId!.trim() : userId;
  if (!isValidUuid(scopeParamVal)) {
    return null;
  }

  const builtWhere = buildFtsWhereClause({
    hasProject,
    userId,
    options,
    queryText,
  });
  if (!builtWhere) return null;

  const sql = `SELECT id FROM "items" WHERE ${builtWhere.whereClause} LIMIT ${Math.max(1, Math.floor(limit))}`;
  return { sql, params: [scopeParamVal, ...builtWhere.sqlParams] };
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

  const builtWhere = buildFtsWhereClause({
    hasProject,
    userId,
    options,
    queryText,
  });
  if (!builtWhere) return null;

  const sqlParams: unknown[] = [scopeParamVal, ...builtWhere.sqlParams];
  let paramIdx = builtWhere.nextParamIdx;
  const whereClause = builtWhere.whereClause;
  const effectiveSortBy = options.sortBy || options.orderBy;
  const effectiveSortDir =
    (options.sortOrder || options.orderDirection) === 'asc' ? 'ASC' : 'DESC';

  const orderExpr =
    effectiveSortBy === 'year'
      ? `year ${effectiveSortDir} NULLS LAST, id ${effectiveSortDir}`
      : effectiveSortBy === 'title'
        ? `NULLIF(TRIM(title), '') ${effectiveSortDir} NULLS LAST, id ${effectiveSortDir}`
        : effectiveSortBy === 'authors' ||
            effectiveSortBy === 'creator' ||
            effectiveSortBy === 'firstAuthor'
          ? `NULLIF(TRIM(first_author), '') ${effectiveSortDir} NULLS LAST, id ${effectiveSortDir}`
          : effectiveSortBy === 'publication' ||
              effectiveSortBy === 'publicationTitle'
            ? `NULLIF(TRIM(publication_title), '') ${effectiveSortDir} NULLS LAST, id ${effectiveSortDir}`
            : effectiveSortBy === 'citationKey'
              ? `NULLIF(TRIM(citation_key), '') ${effectiveSortDir} NULLS LAST, id ${effectiveSortDir}`
              : effectiveSortBy === 'deletedAt' ||
                  effectiveSortBy === 'dateDeleted'
                ? `deleted_at ${effectiveSortDir} NULLS LAST, id ${effectiveSortDir}`
                : effectiveSortBy === 'updatedAt' ||
                    effectiveSortBy === 'dateModified'
                  ? `updated_at ${effectiveSortDir}, id ${effectiveSortDir}`
                  : effectiveSortBy === 'dateAdded' ||
                      effectiveSortBy === 'createdAt'
                    ? `created_at ${effectiveSortDir}, id ${effectiveSortDir}`
                    : `(
              ts_rank_cd(${ITEM_FTS_VECTOR_SQL}, ${builtWhere.tsQuerySqlExpr}, 32) +
              CASE
                WHEN LOWER(COALESCE(title, '')) = LOWER($2) THEN 2.0
                WHEN LOWER(COALESCE(title, '')) LIKE (LOWER($3) || '%') THEN 1.0
                WHEN LOWER(COALESCE(title, '')) LIKE ('%' || LOWER($3) || '%') THEN 0.4
                ELSE 0.0
              END +
              CASE
                WHEN LOWER(COALESCE(citation_key, '')) = LOWER($2) OR LOWER(COALESCE(doi, '')) = LOWER($2) THEN 3.0
                ELSE 0.0
              END
            ) DESC, created_at DESC, id DESC`;

  let cursorCte = '';
  let cursorFilter = '';
  let offsetClause = '';
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
  } else if (options.page && options.page > 1) {
    const offsetParam = paramIdx++;
    sqlParams.push((options.page - 1) * limit);
    offsetClause = `\n       OFFSET $${offsetParam}`;
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
       LIMIT $${limitParam}${offsetClause}`;

  return { sql, params: sqlParams };
}

export function buildSearchTrgmFallbackSqlQuery(params: {
  userId: string;
  options: SearchOptions;
  queryText: string;
  limit: number;
  threshold?: number;
}): { sql: string; params: unknown[] } | null {
  const { userId, options, queryText, limit, threshold = 0.3 } = params;
  const trimmed = queryText.trim();
  if (trimmed.length < 3) return null;
  const hasProject = isProjectScopeId(options.projectId);
  const scopeParamVal = hasProject ? options.projectId!.trim() : userId;
  if (!isValidUuid(scopeParamVal)) return null;

  const foldedQuery = SearchQueryEngine.stripDiacritics(trimmed);
  const scopeWhere = hasProject
    ? `project_id = $1::uuid`
    : `user_id = $1::uuid AND project_id IS NULL`;

  const deletedWhere =
    options.view === 'trash' ? `deleted_at IS NOT NULL` : `deleted_at IS NULL`;

  const sql = `
    SELECT id
    FROM "items"
    WHERE ${scopeWhere}
      AND ${deletedWhere}
      AND (
        word_similarity($2, COALESCE(title, '')) >= $3
        OR word_similarity($2, COALESCE(first_author, '')) >= $3
      )
    ORDER BY GREATEST(
      word_similarity($2, COALESCE(title, '')),
      word_similarity($2, COALESCE(first_author, ''))
    ) DESC, created_at DESC, id DESC
    LIMIT $4
  `;

  return {
    sql,
    params: [scopeParamVal, foldedQuery || trimmed, threshold, limit + 1],
  };
}
