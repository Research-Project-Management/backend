import { Prisma, ReadStatus } from '@prisma/client';
import { SavedSearchOperator } from '@/modules/library/catalog/types/saved-search.types';
import { AcademicSearchQueryEngine } from '@/modules/library/core';

export function evalAnyFieldCondition(
  operator: SavedSearchOperator,
  strVal: string,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') {
    return {
      OR: [
        { title: { not: '' } },
        { abstract: { not: '' } },
        { publicationTitle: { not: '' } },
        { contributors: { some: {} } },
      ],
    };
  }
  if (operator === 'isAbsent') {
    return {
      AND: [
        { title: '' },
        { abstract: '' },
        { publicationTitle: '' },
        { contributors: { none: {} } },
      ],
    };
  }

  const ids = AcademicSearchQueryEngine.extractIdentifiers(strVal);
  const anyFieldClauses: Prisma.ItemWhereInput[] = [
    { title: { contains: strVal, mode: 'insensitive' } },
    { abstract: { contains: strVal, mode: 'insensitive' } },
    { publicationTitle: { contains: strVal, mode: 'insensitive' } },
    { doi: { contains: ids.cleanDoi || strVal, mode: 'insensitive' } },
    { citationKey: { contains: strVal, mode: 'insensitive' } },
    { metadata: { path: ['publisher'], string_contains: strVal } },
    { metadata: { path: ['isbn'], string_contains: ids.cleanIsbn || strVal } },
    { metadata: { path: ['issn'], string_contains: ids.cleanIssn || strVal } },
    ...(ids.cleanArxivBase || ids.cleanArxiv
      ? [
          {
            metadata: {
              path: ['arxivId'],
              string_contains: ids.cleanArxivBase || ids.cleanArxiv!,
            },
          },
        ]
      : []),
    ...(ids.cleanPmid
      ? [{ metadata: { path: ['pmid'], string_contains: ids.cleanPmid } }]
      : []),
    ...(ids.cleanPmcid
      ? [{ metadata: { path: ['pmcid'], string_contains: ids.cleanPmcid } }]
      : []),
    { metadata: { path: ['extra'], string_contains: strVal } },
    {
      contributors: {
        some: {
          OR: [
            { fullName: { contains: strVal, mode: 'insensitive' } },
            { lastName: { contains: strVal, mode: 'insensitive' } },
            { firstName: { contains: strVal, mode: 'insensitive' } },
          ],
        },
      },
    },
    {
      itemTags: {
        some: { tag: { name: { contains: strVal, mode: 'insensitive' } } },
      },
    },
    {
      notesList: {
        some: {
          deletedAt: null,
          OR: [
            { title: { contains: strVal, mode: 'insensitive' } },
            { contentMd: { contains: strVal, mode: 'insensitive' } },
          ],
        },
      },
    },
    {
      attachments: {
        some: {
          deletedAt: null,
          OR: [
            { filename: { contains: strVal, mode: 'insensitive' } },
            {
              fullTextIndexes: {
                some: {
                  textContent: { contains: strVal, mode: 'insensitive' },
                },
              },
            },
          ],
        },
      },
    },
  ];

  if (operator === 'doesNotContain' || operator === 'isNot') {
    return { NOT: { OR: anyFieldClauses } };
  }
  return { OR: anyFieldClauses };
}

export function evalCreatorCondition(
  operator: SavedSearchOperator,
  strVal: string,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { contributors: { some: {} } };
  if (operator === 'isAbsent') return { contributors: { none: {} } };
  if (operator === 'contains' || operator === 'is') {
    return { contributors: { some: { fullName: { contains: strVal, mode: 'insensitive' } } } };
  }
  if (operator === 'doesNotContain' || operator === 'isNot') {
    return { NOT: { contributors: { some: { fullName: { contains: strVal, mode: 'insensitive' } } } } };
  }
  if (operator === 'beginsWith') {
    return { contributors: { some: { fullName: { startsWith: strVal, mode: 'insensitive' } } } };
  }
  if (operator === 'endsWith') {
    return { contributors: { some: { fullName: { endsWith: strVal, mode: 'insensitive' } } } };
  }
  return null;
}

export function evalYearCondition(
  operator: SavedSearchOperator,
  value: unknown,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { year: { not: null } };
  if (operator === 'isAbsent') return { year: null };
  if (operator === 'isBetween' && Array.isArray(value)) {
    const [start, end] = value.map(Number);
    return Number.isFinite(start) && Number.isFinite(end) ? { year: { gte: start, lte: end } } : null;
  }
  const numVal = Number(value);
  if (!Number.isFinite(numVal)) return null;
  if (operator === 'is' || operator === 'equals') return { year: numVal };
  if (operator === 'isNot' || operator === 'not_equals') return { NOT: { year: numVal } };
  if (operator === 'isGreaterThan') return { year: { gt: numVal } };
  if (operator === 'isLessThan') return { year: { lt: numVal } };
  return null;
}

export function evalItemTypeCondition(
  operator: SavedSearchOperator,
  strVal: string,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { itemType: { not: '' } };
  if (operator === 'isAbsent') return { itemType: '' };
  if (operator === 'is' || operator === 'equals') return { itemType: strVal };
  if (operator === 'isNot' || operator === 'not_equals') return { NOT: { itemType: strVal } };
  if (operator === 'contains') return { itemType: { contains: strVal, mode: 'insensitive' } };
  if (operator === 'doesNotContain') return { NOT: { itemType: { contains: strVal, mode: 'insensitive' } } };
  return null;
}

export function evalTagCondition(
  operator: SavedSearchOperator,
  strVal: string,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { itemTags: { some: {} } };
  if (operator === 'isAbsent') return { itemTags: { none: {} } };
  if (operator === 'contains' || operator === 'is') {
    return { itemTags: { some: { tag: { name: { contains: strVal, mode: 'insensitive' } } } } };
  }
  if (operator === 'doesNotContain' || operator === 'isNot') {
    return { NOT: { itemTags: { some: { tag: { name: { contains: strVal, mode: 'insensitive' } } } } } };
  }
  if (operator === 'beginsWith') {
    return { itemTags: { some: { tag: { name: { startsWith: strVal, mode: 'insensitive' } } } } };
  }
  if (operator === 'endsWith') {
    return { itemTags: { some: { tag: { name: { endsWith: strVal, mode: 'insensitive' } } } } };
  }
  return null;
}

export function evalCollectionCondition(
  operator: SavedSearchOperator,
  strVal: string,
  descendantMap?: Map<string, string[]>,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { collectionItems: { some: {} } };
  if (operator === 'isAbsent') return { collectionItems: { none: {} } };
  const targetIds = descendantMap?.get(strVal) || [strVal];
  const collectionCondition =
    targetIds.length === 1 ? { collectionId: targetIds[0] } : { collectionId: { in: targetIds } };

  if (operator === 'is' || operator === 'equals' || operator === 'contains') {
    return { collectionItems: { some: collectionCondition } };
  }
  if (operator === 'isNot' || operator === 'not_equals' || operator === 'doesNotContain') {
    return { NOT: { collectionItems: { some: collectionCondition } } };
  }
  return null;
}

export function evalUserStarredCondition(
  operator: SavedSearchOperator,
  value: unknown,
  strVal: string,
  userId?: string,
): Prisma.ItemWhereInput | null {
  if (!userId) return null;
  const wantStarred =
    operator !== 'isAbsent' && operator !== 'isNot' && value !== false && strVal !== 'false';
  return wantStarred
    ? { states: { some: { userId, isStarred: true } } }
    : { OR: [{ states: { none: { userId } } }, { states: { some: { userId, isStarred: false } } }] };
}

export function evalReadStatusCondition(
  operator: SavedSearchOperator,
  strVal: string,
  userId?: string,
): Prisma.ItemWhereInput | null {
  if (!userId) return null;
  const mappedStatus = strVal === 'read' ? 'completed' : strVal;
  const targetStatus: ReadStatus = (
    mappedStatus === 'reading' || mappedStatus === 'completed' ? mappedStatus : 'unread'
  );
  if (operator === 'isNot') {
    return targetStatus === 'unread'
      ? { states: { some: { userId, readStatus: { not: 'unread' } } } }
      : { OR: [{ states: { none: { userId } } }, { states: { some: { userId, readStatus: { not: targetStatus } } } }] };
  }
  return targetStatus === 'unread'
    ? { OR: [{ states: { none: { userId } } }, { states: { some: { userId, readStatus: 'unread' } } }] }
    : { states: { some: { userId, readStatus: targetStatus } } };
}

export function evalRatingCondition(
  operator: SavedSearchOperator,
  value: unknown,
  userId?: string,
): Prisma.ItemWhereInput | null {
  if (!userId) return null;
  if (operator === 'isPresent') {
    return { states: { some: { userId, rating: { not: null, gt: 0 } } } };
  }
  if (operator === 'isAbsent') {
    return {
      OR: [
        { states: { none: { userId } } },
        {
          states: {
            some: { userId, OR: [{ rating: null }, { rating: 0 }] },
          },
        },
      ],
    };
  }
  if (operator === 'isBetween' && Array.isArray(value)) {
    const [start, end] = value.map(Number);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return { states: { some: { userId, rating: { gte: start, lte: end } } } };
    }
    return null;
  }

  const ratingNum = Number(value);
  if (!Number.isFinite(ratingNum)) return null;

  if (operator === 'isGreaterThan') {
    return { states: { some: { userId, rating: { gt: ratingNum } } } };
  }
  if (operator === 'isLessThan') {
    return { states: { some: { userId, rating: { lt: ratingNum } } } };
  }
  if (operator === 'isNot') {
    return {
      OR: [
        { states: { none: { userId } } },
        { states: { some: { userId, NOT: { rating: ratingNum } } } },
      ],
    };
  }
  return { states: { some: { userId, rating: ratingNum } } };
}

export function evalAttachmentCondition(
  field: 'hasAttachment' | 'attachmentContent' | 'attachmentFilename',
  operator: SavedSearchOperator,
  value: unknown,
  strVal: string,
): Prisma.ItemWhereInput | null {
  if (field === 'hasAttachment') {
    const isNegativeOp =
      operator === 'isAbsent' ||
      operator === 'isNot' ||
      value === false ||
      strVal === 'false';
    return !isNegativeOp
      ? { attachments: { some: { deletedAt: null } } }
      : { attachments: { none: { deletedAt: null } } };
  }

  if (field === 'attachmentFilename') {
    if (operator === 'isPresent')
      return { attachments: { some: { deletedAt: null } } };
    if (operator === 'isAbsent')
      return { attachments: { none: { deletedAt: null } } };
    if (operator === 'contains' || operator === 'is') {
      return {
        attachments: {
          some: {
            deletedAt: null,
            filename: { contains: strVal, mode: 'insensitive' },
          },
        },
      };
    }
    if (operator === 'doesNotContain' || operator === 'isNot') {
      return {
        NOT: {
          attachments: {
            some: {
              deletedAt: null,
              filename: { contains: strVal, mode: 'insensitive' },
            },
          },
        },
      };
    }
    return null;
  }

  if (operator === 'contains' || operator === 'is') {
    return {
      attachments: {
        some: {
          deletedAt: null,
          fullTextIndexes: {
            some: { textContent: { contains: strVal, mode: 'insensitive' } },
          },
        },
      },
    };
  }
  if (operator === 'doesNotContain' || operator === 'isNot') {
    return {
      NOT: {
        attachments: {
          some: {
            deletedAt: null,
            fullTextIndexes: {
              some: { textContent: { contains: strVal, mode: 'insensitive' } },
            },
          },
        },
      },
    };
  }
  if (operator === 'isPresent') {
    return {
      attachments: {
        some: { deletedAt: null, fullTextIndexes: { some: {} } },
      },
    };
  }
  if (operator === 'isAbsent') {
    return {
      attachments: {
        none: { deletedAt: null, fullTextIndexes: { some: {} } },
      },
    };
  }
  return null;
}

export function evalNoteCondition(
  operator: SavedSearchOperator,
  strVal: string,
): Prisma.ItemWhereInput | null {
  const noteOr = [
    { title: { contains: strVal, mode: 'insensitive' as const } },
    { contentMd: { contains: strVal, mode: 'insensitive' as const } },
  ];
  if (operator === 'contains' || operator === 'is') {
    return { notesList: { some: { deletedAt: null, OR: noteOr } } };
  }
  if (operator === 'doesNotContain' || operator === 'isNot') {
    return { NOT: { notesList: { some: { deletedAt: null, OR: noteOr } } } };
  }
  if (operator === 'isPresent') {
    return { notesList: { some: { deletedAt: null } } };
  }
  if (operator === 'isAbsent') {
    return { notesList: { none: { deletedAt: null } } };
  }
  return null;
}
