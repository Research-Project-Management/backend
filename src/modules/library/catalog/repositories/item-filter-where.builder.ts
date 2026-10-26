import { Prisma, ReadStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import { normalizeProjectScopeId } from '@/modules/library/core';

export const isUuid = (val: unknown): val is string =>
  typeof val === 'string' && isUUID(val);

export interface ItemFilterOptions {
  view?:
    | 'all'
    | 'recent'
    | 'unfiled'
    | 'trash'
    | 'my-publications'
    | 'publications'
    | 'starred'
    | 'retracted';
  collectionId?: string;
  collectionIds?: string[];
  targetCollectionIds?: string[];
  tagId?: string;
  tag?: string;
  search?: string;
  hasFile?: boolean;
  hasNotes?: boolean;
  isRetracted?: boolean;
  onlyFlagged?: boolean;
  projectId?: string;
  itemType?: string;
  type?: string;
  fromYear?: number;
  toYear?: number;
  readStatus?: string;
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;
  userId?: string;
}

/**
 * Constructs comprehensive search filters covering Zotero fields:
 * - 'title_creator_year': title, year, and contributor names
 * - 'fields_tags': all bibliographic fields + tags
 * - 'everything' (default): all bibliographic fields + tags + notes + attachments + fulltext
 */
export function buildItemSearchCondition(
  search: string,
  searchMode?: string,
): Prisma.ItemWhereInput[] {
  const trimmed = search.trim();
  const numericYear = /^\d{4}$/.test(trimmed) ? Number(trimmed) : null;

  const creatorClause: Prisma.ItemWhereInput = {
    contributors: {
      some: {
        OR: [
          { fullName: { contains: trimmed, mode: 'insensitive' } },
          { lastName: { contains: trimmed, mode: 'insensitive' } },
          { firstName: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
    },
  };

  if (searchMode === 'title_creator_year') {
    const clauses: Prisma.ItemWhereInput[] = [
      { title: { contains: trimmed, mode: 'insensitive' } },
      creatorClause,
    ];
    if (numericYear !== null) {
      clauses.push({ year: numericYear });
    }
    return clauses;
  }

  const baseClauses: Prisma.ItemWhereInput[] = [
    { title: { contains: trimmed, mode: 'insensitive' } },
    { publicationTitle: { contains: trimmed, mode: 'insensitive' } },
    { abstract: { contains: trimmed, mode: 'insensitive' } },
    { doi: { contains: trimmed, mode: 'insensitive' } },
    { citationKey: { contains: trimmed, mode: 'insensitive' } },
    ...(numericYear !== null ? [{ year: numericYear }] : []),
    {
      metadata: {
        path: ['isbn'],
        string_contains: trimmed,
      },
    },
    {
      metadata: {
        path: ['issn'],
        string_contains: trimmed,
      },
    },
    {
      metadata: {
        path: ['pmid'],
        string_contains: trimmed,
      },
    },
    {
      metadata: {
        path: ['arxivId'],
        string_contains: trimmed,
      },
    },
    {
      metadata: {
        path: ['publisher'],
        string_contains: trimmed,
      },
    },
    creatorClause,
    {
      itemTags: {
        some: {
          tag: {
            name: { contains: trimmed, mode: 'insensitive' },
          },
        },
      },
    },
  ];

  if (searchMode === 'fields_tags') {
    return baseClauses;
  }

  if (searchMode === 'everything') {
    return [
      ...baseClauses,
      {
        notesList: {
          some: {
            deletedAt: null,
            OR: [
              { title: { contains: trimmed, mode: 'insensitive' } },
              { contentMd: { contains: trimmed, mode: 'insensitive' } },
            ],
          },
        },
      },
      {
        attachments: {
          some: {
            deletedAt: null,
            OR: [
              { filename: { contains: trimmed, mode: 'insensitive' } },
              {
                fullTextIndexes: {
                  some: {
                    textContent: { contains: trimmed, mode: 'insensitive' },
                  },
                },
              },
            ],
          },
        },
      },
    ];
  }

  // Default backward-compatible bibliographic + contributor search
  return baseClauses.slice(0, -1);
}

/**
 * Builds a shared CatalogItem WHERE clause from the common filter options.
 * Used by both findMany and count to avoid duplicated logic.
 */
export function buildItemWhereClause(
  userId: string,
  options: ItemFilterOptions,
): Prisma.ItemWhereInput {
  const view = options.view ?? 'all';
  const validProjectId = normalizeProjectScopeId(options.projectId);
  const where: Prisma.ItemWhereInput =
    validProjectId && isUuid(validProjectId)
      ? { projectId: validProjectId }
      : { userId, projectId: null };

  const andConditions: Prisma.ItemWhereInput[] = [];

  if (view === 'trash') {
    where.deletedAt = { not: null };
  } else {
    where.deletedAt = null;
    if (view === 'unfiled') {
      where.collectionItems = { none: {} };
    } else if (view === 'my-publications' || view === 'publications') {
      andConditions.push({
        OR: [
          { metadata: { path: ['isMyPublication'], equals: true } },
          { publications: { some: { userId } } },
        ],
      });
    } else if (view === 'starred') {
      where.states = { some: { userId, isStarred: true } };
    } else if (view === 'retracted') {
      andConditions.push({
        metadata: { path: ['isRetracted'], equals: true },
      });
    }
  }

  if (options.isRetracted !== undefined && view !== 'retracted') {
    if (options.isRetracted) {
      andConditions.push({
        metadata: { path: ['isRetracted'], equals: true },
      });
    } else {
      andConditions.push({
        NOT: { metadata: { path: ['isRetracted'], equals: true } },
      });
    }
  }

  if (options.onlyFlagged) {
    where.states = {
      some: {
        userId,
        isStarred: true,
      },
    };
  }

  if (options.hasFile !== undefined) {
    where.hasFile = options.hasFile;
  }

  if (options.hasNotes !== undefined) {
    if (options.hasNotes) {
      where.noteCount = { gt: 0 };
    } else {
      where.noteCount = 0;
    }
  }

  const targetCollectionIds =
    options.targetCollectionIds || options.collectionIds;
  if (targetCollectionIds && targetCollectionIds.length > 0) {
    if (targetCollectionIds.length === 1) {
      where.collectionItems = {
        some: { collectionId: targetCollectionIds[0] },
      };
    } else {
      where.collectionItems = {
        some: { collectionId: { in: targetCollectionIds } },
      };
    }
  } else if (options.collectionId) {
    where.collectionItems = { some: { collectionId: options.collectionId } };
  }

  if (options.tagId) {
    where.itemTags = { some: { tagId: options.tagId } };
  }

  if (options.tag) {
    const tagNames = options.tag
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tagNames.length > 0) {
      where.itemTags = {
        some: {
          tag: {
            OR: tagNames.map((name) => ({
              name: { equals: name, mode: 'insensitive' as const },
            })),
          },
        },
      };
    }
  }

  const itemType = options.itemType || options.type;
  if (itemType) {
    if (itemType.includes(',')) {
      const types = itemType
        .split(',')
        .map((t: string) => t.trim())
        .filter(Boolean);
      where.itemType = { in: types };
    } else {
      where.itemType = itemType;
    }
  }

  if (options.fromYear !== undefined || options.toYear !== undefined) {
    where.year = {
      ...(options.fromYear !== undefined
        ? { gte: Number(options.fromYear) }
        : {}),
      ...(options.toYear !== undefined ? { lte: Number(options.toYear) } : {}),
    };
  }

  if (options.readStatus && options.readStatus !== 'all') {
    const validStatuses: ReadStatus[] = ['unread', 'reading', 'completed'];
    const statuses = options.readStatus
      .split(',')
      .map((s) => s.trim() === 'read' ? 'completed' : s.trim())
      .filter((s): s is ReadStatus => validStatuses.includes(s as ReadStatus));
    if (statuses.length > 0) {
      if (statuses.length === 1 && statuses[0] === 'unread') {
        andConditions.push({
          OR: [
            { states: { none: { userId } } },
            { states: { some: { userId, readStatus: 'unread' } } },
          ],
        });
      } else {
        const existingSome =
          where.states && typeof where.states === 'object' && 'some' in where.states && where.states.some
            ? (where.states.some as Prisma.StateWhereInput)
            : {};
        where.states = {
          some: {
            ...existingSome,
            userId,
            readStatus: statuses.length > 1 ? { in: statuses } : statuses[0],
          },
        };
      }
    }
  }

  if (options.search) {
    andConditions.push({
      OR: buildItemSearchCondition(options.search, options.searchMode),
    });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}
