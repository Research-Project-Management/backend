import { Injectable, Optional } from '@nestjs/common';
import { Prisma, ReadStatus } from '@prisma/client';
import { PrismaService } from '@/core';
import { TreeEngine } from './tree.engine';
import {
  SavedSearchCondition,
  SavedSearchConditionGroup,
  isConditionGroup,
  SavedSearchOperator,
  SavedSearchScopeOptions,
} from '@/modules/library/catalog/types/saved-search.types';
import { FIELD_ALIASES } from '@/modules/library/catalog/types/items.constants';

import {
  evalJsonField,
  evalStringField,
  evalDateField,
  parseRelativeDuration,
} from './condition-field-evaluators.helper';
export {
  evalJsonField,
  evalStringField,
  evalDateField,
  parseRelativeDuration,
};

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

  const anyFieldClauses: Prisma.ItemWhereInput[] = [
    { title: { contains: strVal, mode: 'insensitive' } },
    { abstract: { contains: strVal, mode: 'insensitive' } },
    { publicationTitle: { contains: strVal, mode: 'insensitive' } },
    { doi: { contains: strVal, mode: 'insensitive' } },
    { citationKey: { contains: strVal, mode: 'insensitive' } },
    { metadata: { path: ['publisher'], string_contains: strVal } },
    { metadata: { path: ['isbn'], string_contains: strVal } },
    { metadata: { path: ['issn'], string_contains: strVal } },
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
  if (operator === 'is') return { year: numVal };
  if (operator === 'isNot') return { NOT: { year: numVal } };
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
  if (operator === 'is') return { itemType: strVal };
  if (operator === 'isNot') return { NOT: { itemType: strVal } };
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

  if (operator === 'is' || operator === 'contains') {
    return { collectionItems: { some: collectionCondition } };
  }
  if (operator === 'isNot' || operator === 'doesNotContain') {
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

const DIRECT_ITEM_COLUMNS = new Set([
  'title',
  'itemType',
  'year',
  'citationKey',
  'doi',
  'publicationTitle',
  'abstract',
  'url',
  'userId',
  'projectId',
  'firstAuthor',
  'createdAt',
  'updatedAt',
]);

const OPERATOR_ALIASES: Record<string, SavedSearchOperator> = {
  is_not: 'isNot',
  does_not_contain: 'doesNotContain',
  begins_with: 'beginsWith',
  ends_with: 'endsWith',
  greater_than: 'isGreaterThan',
  gt: 'isGreaterThan',
  less_than: 'isLessThan',
  lt: 'isLessThan',
  between: 'isBetween',
  in_the_last: 'isInTheLast',
  is_present: 'isPresent',
  is_absent: 'isAbsent',
};

const SEARCH_FIELD_ALIASES: Record<string, string> = {
  author: 'creator',
  authors: 'creator',
  contributor: 'creator',
  contributors: 'creator',
  hasPdf: 'hasAttachment',
  has_pdf: 'hasAttachment',
  has_attachment: 'hasAttachment',
  read_status: 'readStatus',
  is_starred: 'isStarred',
  starred: 'isStarred',
  item_type: 'itemType',
  publication_title: 'publicationTitle',
  citation_key: 'citationKey',
  citekey: 'citationKey',
};

@Injectable()
export class ConditionEvaluatorEngine {
  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly treeEngine: TreeEngine = new TreeEngine(),
  ) {}

  compile(
    userId: string,
    group: SavedSearchConditionGroup,
    projectId?: string,
  ): Prisma.ItemWhereInput | Promise<Prisma.ItemWhereInput> {
    const baseWhere: Prisma.ItemWhereInput = projectId
      ? { projectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };

    if (!group?.conditions?.length) return baseWhere;

    const optionsFallback =
      'options' in group && group.options && typeof group.options === 'object'
        ? (group.options as SavedSearchScopeOptions)
        : {};
    const scopeOptions = group.scopeOptions || optionsFallback;
    const searchSubcollections = scopeOptions.searchSubcollections !== false;

    if (this.prisma && searchSubcollections) {
      const referencedCollectionIds = this.extractCollectionIds(group);
      if (referencedCollectionIds.length > 0) {
        return this.compileAsync(
          userId,
          group,
          projectId,
          baseWhere,
          referencedCollectionIds,
        );
      }
    }

    return this.buildCompiledQuery(group, userId, baseWhere, new Map());
  }

  private async compileAsync(
    userId: string,
    group: SavedSearchConditionGroup,
    projectId: string | undefined,
    baseWhere: Prisma.ItemWhereInput,
    referencedCollectionIds: string[],
  ): Promise<Prisma.ItemWhereInput> {
    const descendantMap = new Map<string, string[]>();
    const scopeWhere: Prisma.CollectionWhereInput = projectId
      ? { projectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };
    try {
      const allCollections = await this.prisma!.collection.findMany({
        where: scopeWhere,
        select: { id: true, parentId: true },
      });
      for (const colId of referencedCollectionIds) {
        const descendants = this.treeEngine.getDescendantIds(
          allCollections,
          colId,
        );
        descendantMap.set(colId, [colId, ...descendants]);
      }
    } catch {
      // Graceful fallback
    }
    return this.buildCompiledQuery(group, userId, baseWhere, descendantMap);
  }

  private buildCompiledQuery(
    group: SavedSearchConditionGroup,
    userId: string,
    baseWhere: Prisma.ItemWhereInput,
    descendantMap: Map<string, string[]>,
  ): Prisma.ItemWhereInput {
    const optionsFallback =
      'options' in group && group.options && typeof group.options === 'object'
        ? (group.options as SavedSearchScopeOptions)
        : {};
    const scopeOptions = group.scopeOptions || optionsFallback;
    const andConditions: Prisma.ItemWhereInput[] = [
      baseWhere,
      this.evaluateGroup(group, userId, descendantMap),
    ];

    if (scopeOptions.showOnlyTopLevel) {
      andConditions.push({
        itemType: { notIn: ['attachment', 'annotation', 'note'] },
      });
    }
    return { AND: andConditions };
  }

  private extractCollectionIds(group: SavedSearchConditionGroup): string[] {
    const ids: string[] = [];
    for (const cond of group.conditions) {
      if (isConditionGroup(cond)) {
        ids.push(...this.extractCollectionIds(cond));
      } else if (
        cond.field === 'collection' &&
        cond.value &&
        typeof cond.value === 'string'
      ) {
        ids.push(cond.value.trim());
      }
    }
    return [...new Set(ids)];
  }

  private evaluateGroup(
    group: SavedSearchConditionGroup,
    userId?: string,
    descendantMap?: Map<string, string[]>,
  ): Prisma.ItemWhereInput {
    const clauses: Prisma.ItemWhereInput[] = [];
    for (const item of group.conditions) {
      if (isConditionGroup(item)) {
        clauses.push(this.evaluateGroup(item, userId, descendantMap));
      } else {
        const leafClause = this.evaluateCondition(item, userId, descendantMap);
        if (leafClause) clauses.push(leafClause);
      }
    }
    if (clauses.length === 0) return {};
    const mode = (group.conjunction || group.matchMode || 'AND').toUpperCase();
    return mode === 'OR' || mode === 'ANY' ? { OR: clauses } : { AND: clauses };
  }

  private evaluateCondition(
    cond: SavedSearchCondition,
    userId?: string,
    descendantMap?: Map<string, string[]>,
  ): Prisma.ItemWhereInput | null {
    const { field, operator: rawOperator, value } = cond;
    const operator: SavedSearchOperator =
      OPERATOR_ALIASES[rawOperator] || rawOperator;
    const strVal =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
        ? String(value).trim()
        : '';
    const normalizedField =
      SEARCH_FIELD_ALIASES[field] || FIELD_ALIASES[field] || field;

    switch (normalizedField) {
      case 'anyField':
        return evalAnyFieldCondition(operator, strVal);
      case 'creator':
        return evalCreatorCondition(operator, strVal);
      case 'year':
        return evalYearCondition(operator, value);
      case 'itemType':
        return evalItemTypeCondition(operator, strVal);
      case 'tag':
        return evalTagCondition(operator, strVal);
      case 'collection':
        return evalCollectionCondition(operator, strVal, descendantMap);
      case 'hasAttachment':
      case 'hasPdf':
        return evalAttachmentCondition(
          'hasAttachment',
          operator,
          value,
          strVal,
        );
      case 'isStarred':
        return evalUserStarredCondition(operator, value, strVal, userId);
      case 'readStatus':
        return evalReadStatusCondition(operator, strVal, userId);
      case 'rating':
        return evalRatingCondition(operator, value, userId);
      case 'dateAdded':
        return evalDateField('createdAt', operator, value);
      case 'dateModified':
        return evalDateField('updatedAt', operator, value);
      case 'publicationDate':
      case 'date':
        return evalJsonField('publicationDate', operator, strVal);
      case 'accessedAt':
      case 'accessDate':
        return evalJsonField('accessedAt', operator, strVal);
      case 'attachmentContent':
        return evalAttachmentCondition(
          'attachmentContent',
          operator,
          value,
          strVal,
        );
      case 'attachmentFilename':
      case 'filename':
        return evalAttachmentCondition(
          'attachmentFilename',
          operator,
          value,
          strVal,
        );
      case 'noteContent':
      case 'note':
        return evalNoteCondition(operator, strVal);
      default:
        return DIRECT_ITEM_COLUMNS.has(normalizedField)
          ? evalStringField(normalizedField, operator, strVal)
          : evalJsonField(normalizedField, operator, strVal);
    }
  }
}
