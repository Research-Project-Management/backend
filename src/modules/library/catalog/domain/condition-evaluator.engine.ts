import { Injectable, Optional, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import {
  evalAnyFieldCondition,
  evalCreatorCondition,
  evalYearCondition,
  evalItemTypeCondition,
  evalTagCondition,
  evalCollectionCondition,
  evalUserStarredCondition,
  evalReadStatusCondition,
  evalRatingCondition,
  evalAttachmentCondition,
  evalNoteCondition,
} from './condition-operators.strategy';

export {
  evalJsonField,
  evalStringField,
  evalDateField,
  parseRelativeDuration,
  evalAnyFieldCondition,
  evalCreatorCondition,
  evalYearCondition,
  evalItemTypeCondition,
  evalTagCondition,
  evalCollectionCondition,
  evalUserStarredCondition,
  evalReadStatusCondition,
  evalRatingCondition,
  evalAttachmentCondition,
  evalNoteCondition,
};

const MAX_CONDITION_DEPTH = 5;
const MAX_CONDITION_COUNT = 50;

const DIRECT_ITEM_COLUMNS = new Set([
  'title',
  'itemType',
  'year',
  'citationKey',
  'doi',
  'publicationTitle',
  'abstract',
  'url',
  'firstAuthor',
  'createdAt',
  'updatedAt',
]);

const UUID_ITEM_COLUMNS = new Set(['userId', 'projectId']);

const OPERATOR_ALIASES: Record<string, SavedSearchOperator> = {
  equals: 'is',
  is_not: 'isNot',
  not_equals: 'isNot',
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
  arxiv: 'arxivId',
  arxiv_id: 'arxivId',
  archiveId: 'arxivId',
  archiveID: 'arxivId',
};

@Injectable()
export class ConditionEvaluatorEngine {
  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly treeEngine: TreeEngine = new TreeEngine(),
  ) {}

  private validateGroupStructure(
    group: SavedSearchConditionGroup,
    depth: number = 0,
    counter: { count: number } = { count: 0 },
  ): void {
    if (!group || typeof group !== 'object' || !Array.isArray(group.conditions)) {
      throw new BadRequestException('Invalid condition group structure');
    }
    if (depth > MAX_CONDITION_DEPTH) {
      throw new BadRequestException(
        `Saved search condition nesting depth exceeds maximum allowed (${MAX_CONDITION_DEPTH})`,
      );
    }
    for (const item of group.conditions) {
      if (!item || typeof item !== 'object') {
        throw new BadRequestException('Invalid condition element');
      }
      if (isConditionGroup(item)) {
        this.validateGroupStructure(item, depth + 1, counter);
      } else {
        counter.count += 1;
        if (counter.count > MAX_CONDITION_COUNT) {
          throw new BadRequestException(
            `Saved search condition count exceeds maximum allowed (${MAX_CONDITION_COUNT})`,
          );
        }
        const cond = item as SavedSearchCondition;
        if (!cond.field || typeof cond.field !== 'string' || !cond.operator || typeof cond.operator !== 'string') {
          throw new BadRequestException('Condition must have valid field and operator');
        }
      }
    }
  }

  compile(
    userId: string,
    group: SavedSearchConditionGroup,
    projectId?: string,
  ): Prisma.ItemWhereInput | Promise<Prisma.ItemWhereInput> {
    const baseWhere: Prisma.ItemWhereInput = projectId
      ? { projectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };

    if (!group) return baseWhere;
    if (typeof group !== 'object' || (group.conditions !== undefined && !Array.isArray(group.conditions))) {
      throw new BadRequestException('Invalid saved search conditions');
    }
    if (!group.conditions?.length) return baseWhere;

    this.validateGroupStructure(group, 0, { count: 0 });

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

  private extractCollectionIds(
    group: SavedSearchConditionGroup,
    depth: number = 0,
  ): string[] {
    if (depth > MAX_CONDITION_DEPTH || !Array.isArray(group?.conditions)) {
      return [];
    }
    const ids: string[] = [];
    for (const cond of group.conditions) {
      if (!cond || typeof cond !== 'object') continue;
      if (isConditionGroup(cond)) {
        ids.push(...this.extractCollectionIds(cond, depth + 1));
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
    depth: number = 0,
    counter: { count: number } = { count: 0 },
  ): Prisma.ItemWhereInput {
    if (depth > MAX_CONDITION_DEPTH) {
      throw new BadRequestException(
        `Saved search condition nesting depth exceeds maximum allowed (${MAX_CONDITION_DEPTH})`,
      );
    }
    if (!group || typeof group !== 'object' || !Array.isArray(group.conditions)) {
      return {};
    }
    const clauses: Prisma.ItemWhereInput[] = [];
    for (const item of group.conditions) {
      if (!item || typeof item !== 'object') continue;
      if (isConditionGroup(item)) {
        clauses.push(
          this.evaluateGroup(item, userId, descendantMap, depth + 1, counter),
        );
      } else {
        counter.count += 1;
        if (counter.count > MAX_CONDITION_COUNT) {
          throw new BadRequestException(
            `Saved search condition count exceeds maximum allowed (${MAX_CONDITION_COUNT})`,
          );
        }
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
    if (!cond || typeof cond !== 'object') return null;
    const { field, operator: rawOperator, value } = cond;
    if (!field || typeof field !== 'string' || !rawOperator || typeof rawOperator !== 'string') {
      return null;
    }
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
        if (UUID_ITEM_COLUMNS.has(normalizedField)) {
          if (operator === 'isPresent') return { [normalizedField]: { not: null } };
          if (operator === 'isAbsent') return { [normalizedField]: null };
          if (operator === 'is') return strVal ? { [normalizedField]: strVal } : null;
          if (operator === 'isNot') return strVal ? { NOT: { [normalizedField]: strVal } } : null;
          return null;
        }
        return DIRECT_ITEM_COLUMNS.has(normalizedField)
          ? evalStringField(normalizedField, operator, strVal)
          : evalJsonField(normalizedField, operator, strVal);
    }
  }
}
