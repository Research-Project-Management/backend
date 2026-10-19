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
  userId?: string;
}

/**
 * Constructs comprehensive search filters covering Zotero fields:
 * title, abstract, doi, publicationTitle, publisher, citationKey, arxivId,
 * isbn, issn, extra, and contributor names (fullName, lastName, firstName).
 */
export function buildItemSearchCondition(
  search: string,
): Prisma.ItemWhereInput[] {
  const trimmed = search.trim();
  return [
    { title: { contains: trimmed, mode: 'insensitive' } },
    { publicationTitle: { contains: trimmed, mode: 'insensitive' } },
    { abstract: { contains: trimmed, mode: 'insensitive' } },
    { doi: { contains: trimmed, mode: 'insensitive' } },
    { citationKey: { contains: trimmed, mode: 'insensitive' } },
    {
      contributors: {
        some: {
          OR: [
            { fullName: { contains: trimmed, mode: 'insensitive' } },
            { lastName: { contains: trimmed, mode: 'insensitive' } },
            { firstName: { contains: trimmed, mode: 'insensitive' } },
          ],
        },
      },
    },
  ];
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
      .map((s) => s.trim())
      .filter((s): s is ReadStatus => validStatuses.includes(s as ReadStatus));
    if (statuses.length > 0) {
      where.states = {
        some: {
          userId,
          readStatus: statuses.length > 1 ? { in: statuses } : statuses[0],
        },
      };
    }
  }

  if (options.search) {
    andConditions.push({
      OR: buildItemSearchCondition(options.search),
    });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}
