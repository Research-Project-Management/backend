import { Injectable, Optional } from '@nestjs/common';
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
} from './condition-scalar.evaluator';
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
} from './condition-relation.evaluator';

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
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly treeEngine: TreeEngine = new TreeEngine(),
  ) {}

  /**
   * Translates a SavedSearchConditionGroup AST into a Prisma ItemWhereInput query.
   * Scopes to projectId when specified (collaborative library) or userId (personal library).
   * Resolves recursive subcollections and top-level constraints asynchronously.
   */
  compile(
    userId: string,
    group: SavedSearchConditionGroup,
    projectId?: string,
  ): Prisma.ItemWhereInput | Promise<Prisma.ItemWhereInput> {
    const baseWhere: Prisma.ItemWhereInput = projectId
      ? { projectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };

    if (
      !group ||
      !Array.isArray(group.conditions) ||
      group.conditions.length === 0
    ) {
      return baseWhere;
    }

    const optionsFallback =
      'options' in group && group.options && typeof group.options === 'object'
        ? (group.options as SavedSearchScopeOptions)
        : {};
    const scopeOptions = group.scopeOptions || optionsFallback;
    const searchSubcollections = scopeOptions.searchSubcollections !== false;

    // If Prisma is available and subcollection search is enabled, resolve descendants asynchronously
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
      // Graceful fallback if database lookup fails
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
    const showOnlyTopLevel = Boolean(scopeOptions.showOnlyTopLevel);

    const compiledGroup = this.evaluateGroup(group, userId, descendantMap);
    const andConditions: Prisma.ItemWhereInput[] = [baseWhere, compiledGroup];

    if (showOnlyTopLevel) {
      andConditions.push({
        itemType: { notIn: ['attachment', 'annotation', 'note'] },
      });
    }

    return {
      AND: andConditions,
    };
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
        if (leafClause) {
          clauses.push(leafClause);
        }
      }
    }

    if (clauses.length === 0) {
      return {};
    }

    const mode = (group.conjunction || group.matchMode || 'AND').toUpperCase();
    if (mode === 'OR' || mode === 'ANY') {
      return { OR: clauses };
    }

    return { AND: clauses };
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

    // Handle field aliases
    const normalizedField =
      SEARCH_FIELD_ALIASES[field] || FIELD_ALIASES[field] || field;

    switch (normalizedField) {
      case 'anyField':
        return evalAnyFieldCondition(operator, strVal);
      case 'title':
        return evalStringField('title', operator, strVal);
      case 'abstract':
        return evalStringField('abstract', operator, strVal);
      case 'publicationTitle':
        return evalStringField('publicationTitle', operator, strVal);
      case 'publisher':
        return evalJsonField('publisher', operator, strVal);
      case 'doi':
        return evalStringField('doi', operator, strVal);
      case 'isbn':
        return evalJsonField('isbn', operator, strVal);
      case 'issn':
        return evalJsonField('issn', operator, strVal);
      case 'citationKey':
        return evalStringField('citationKey', operator, strVal);
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
      case 'url':
        return evalStringField('url', operator, strVal);
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
      default: {
        if (DIRECT_ITEM_COLUMNS.has(normalizedField)) {
          return evalStringField(normalizedField, operator, strVal);
        }
        return evalJsonField(normalizedField, operator, strVal);
      }
    }
  }
}
