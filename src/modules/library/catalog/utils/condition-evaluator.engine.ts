import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../core/database/prisma.service';
import { TreeEngine } from './tree.engine';
import {
  SavedSearchCondition,
  SavedSearchConditionGroup,
  isConditionGroup,
  SavedSearchOperator,
} from '../types/saved-search.types';
import { FIELD_ALIASES } from '../types/items.constants';

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
      : { userId, deletedAt: null };

    if (
      !group ||
      !Array.isArray(group.conditions) ||
      group.conditions.length === 0
    ) {
      return baseWhere;
    }

    const scopeOptions = group.scopeOptions || (group as any).options || {};
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
          allCollections as any,
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
    const scopeOptions = group.scopeOptions || (group as any).options || {};
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

    if (group.conjunction === 'OR') {
      return { OR: clauses };
    }

    return { AND: clauses };
  }

  private evaluateCondition(
    cond: SavedSearchCondition,
    userId?: string,
    descendantMap?: Map<string, string[]>,
  ): Prisma.ItemWhereInput | null {
    const { field, operator, value } = cond;
    const strVal =
      value !== undefined && value !== null ? String(value).trim() : '';

    // Handle field aliases (e.g. abstractNote -> abstract, journal -> publicationTitle)
    const normalizedField = FIELD_ALIASES[field] || field;

    switch (normalizedField) {
      case 'anyField': {
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
              some: {
                tag: {
                  name: { contains: strVal, mode: 'insensitive' },
                },
              },
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

      case 'title':
        return this.evalStringField('title', operator, strVal);

      case 'abstract':
        return this.evalStringField('abstract', operator, strVal);

      case 'publicationTitle':
        return this.evalStringField('publicationTitle', operator, strVal);

      case 'publisher':
        return this.evalJsonField('publisher', operator, strVal);

      case 'doi':
        return this.evalStringField('doi', operator, strVal);

      case 'isbn':
        return this.evalJsonField('isbn', operator, strVal);

      case 'issn':
        return this.evalJsonField('issn', operator, strVal);

      case 'citationKey':
        return this.evalStringField('citationKey', operator, strVal);

      case 'creator':
        if (operator === 'isPresent') {
          return { contributors: { some: {} } };
        }
        if (operator === 'isAbsent') {
          return { contributors: { none: {} } };
        }
        if (operator === 'contains' || operator === 'is') {
          return {
            contributors: {
              some: {
                fullName: { contains: strVal, mode: 'insensitive' },
              },
            },
          };
        }
        if (operator === 'doesNotContain' || operator === 'isNot') {
          return {
            NOT: {
              contributors: {
                some: {
                  fullName: { contains: strVal, mode: 'insensitive' },
                },
              },
            },
          };
        }
        if (operator === 'beginsWith') {
          return {
            contributors: {
              some: {
                fullName: { startsWith: strVal, mode: 'insensitive' },
              },
            },
          };
        }
        if (operator === 'endsWith') {
          return {
            contributors: {
              some: {
                fullName: { endsWith: strVal, mode: 'insensitive' },
              },
            },
          };
        }
        return null;

      case 'year': {
        if (operator === 'isPresent') {
          return { year: { not: null } };
        }
        if (operator === 'isAbsent') {
          return { year: null };
        }
        if (operator === 'isBetween' && Array.isArray(value)) {
          const [start, end] = value.map(Number);
          if (Number.isFinite(start) && Number.isFinite(end)) {
            return { year: { gte: start, lte: end } };
          }
          return null;
        }
        const numVal = Number(value);
        if (!Number.isFinite(numVal)) {
          return null;
        }
        if (operator === 'is') {
          return { year: numVal };
        }
        if (operator === 'isNot') {
          return { NOT: { year: numVal } };
        }
        if (operator === 'isGreaterThan') {
          return { year: { gt: numVal } };
        }
        if (operator === 'isLessThan') {
          return { year: { lt: numVal } };
        }
        return null;
      }

      case 'itemType':
        if (operator === 'isPresent') {
          return { itemType: { not: '' } };
        }
        if (operator === 'isAbsent') {
          return { itemType: '' };
        }
        if (operator === 'is') {
          return { itemType: strVal };
        }
        if (operator === 'isNot') {
          return { NOT: { itemType: strVal } };
        }
        if (operator === 'contains') {
          return { itemType: { contains: strVal, mode: 'insensitive' } };
        }
        if (operator === 'doesNotContain') {
          return {
            NOT: { itemType: { contains: strVal, mode: 'insensitive' } },
          };
        }
        return null;

      case 'tag':
        if (operator === 'isPresent') {
          return { itemTags: { some: {} } };
        }
        if (operator === 'isAbsent') {
          return { itemTags: { none: {} } };
        }
        if (operator === 'contains' || operator === 'is') {
          return {
            itemTags: {
              some: {
                tag: {
                  name: { contains: strVal, mode: 'insensitive' },
                },
              },
            },
          };
        }
        if (operator === 'doesNotContain' || operator === 'isNot') {
          return {
            NOT: {
              itemTags: {
                some: {
                  tag: {
                    name: { contains: strVal, mode: 'insensitive' },
                  },
                },
              },
            },
          };
        }
        if (operator === 'beginsWith') {
          return {
            itemTags: {
              some: {
                tag: {
                  name: { startsWith: strVal, mode: 'insensitive' },
                },
              },
            },
          };
        }
        if (operator === 'endsWith') {
          return {
            itemTags: {
              some: {
                tag: {
                  name: { endsWith: strVal, mode: 'insensitive' },
                },
              },
            },
          };
        }
        return null;

      case 'collection': {
        if (operator === 'isPresent') {
          return { collectionItems: { some: {} } };
        }
        if (operator === 'isAbsent') {
          return { collectionItems: { none: {} } };
        }
        const targetIds = descendantMap?.get(strVal) || [strVal];
        const collectionCondition =
          targetIds.length === 1
            ? { collectionId: targetIds[0] }
            : { collectionId: { in: targetIds } };

        if (operator === 'is' || operator === 'contains') {
          return { collectionItems: { some: collectionCondition } };
        }
        if (operator === 'isNot' || operator === 'doesNotContain') {
          return { NOT: { collectionItems: { some: collectionCondition } } };
        }
        return null;
      }

      case 'hasAttachment': {
        const boolVal =
          value === true ||
          strVal === 'true' ||
          operator === 'isPresent' ||
          operator === 'is';
        if (boolVal) {
          return { attachments: { some: {} } };
        }
        return { attachments: { none: {} } };
      }

      case 'readStatus': {
        if (!userId) {
          return null;
        }
        const targetStatus = (strVal || 'unread') as any;
        if (operator === 'isNot') {
          if (targetStatus === 'unread') {
            return {
              states: {
                some: {
                  userId,
                  readStatus: { not: 'unread' },
                },
              },
            };
          }
          return {
            OR: [
              { states: { none: { userId } } },
              {
                states: {
                  some: {
                    userId,
                    readStatus: { not: targetStatus },
                  },
                },
              },
            ],
          };
        }

        if (targetStatus === 'unread') {
          return {
            OR: [
              { states: { none: { userId } } },
              { states: { some: { userId, readStatus: 'unread' } } },
            ],
          };
        }
        return {
          states: {
            some: {
              userId,
              readStatus: targetStatus,
            },
          },
        };
      }

      case 'rating': {
        if (!userId) {
          return null;
        }
        if (operator === 'isPresent') {
          return {
            states: {
              some: {
                userId,
                rating: { not: null, gt: 0 },
              },
            },
          };
        }
        if (operator === 'isAbsent') {
          return {
            OR: [
              { states: { none: { userId } } },
              {
                states: {
                  some: {
                    userId,
                    OR: [{ rating: null }, { rating: 0 }],
                  },
                },
              },
            ],
          };
        }
        if (operator === 'isBetween' && Array.isArray(value)) {
          const [start, end] = value.map(Number);
          if (Number.isFinite(start) && Number.isFinite(end)) {
            return {
              states: {
                some: {
                  userId,
                  rating: { gte: start, lte: end },
                },
              },
            };
          }
          return null;
        }

        const ratingNum = Number(value);
        if (!Number.isFinite(ratingNum)) {
          return null;
        }

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

      case 'dateAdded':
        return this.evalDateField('createdAt', operator, value);

      case 'dateModified':
        return this.evalDateField('updatedAt', operator, value);

      case 'publicationDate':
      case 'date':
        return this.evalJsonField('publicationDate', operator, strVal);

      case 'accessedAt':
      case 'accessDate':
        return this.evalJsonField('accessedAt', operator, strVal);

      case 'url':
        return this.evalStringField('url', operator, strVal);

      case 'attachmentContent':
        if (operator === 'contains' || operator === 'is') {
          return {
            attachments: {
              some: {
                fullTextIndexes: {
                  some: {
                    textContent: { contains: strVal, mode: 'insensitive' },
                  },
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
                  fullTextIndexes: {
                    some: {
                      textContent: { contains: strVal, mode: 'insensitive' },
                    },
                  },
                },
              },
            },
          };
        }
        if (operator === 'isPresent') {
          return {
            attachments: {
              some: {
                fullTextIndexes: { some: {} },
              },
            },
          };
        }
        if (operator === 'isAbsent') {
          return {
            attachments: {
              none: {
                fullTextIndexes: { some: {} },
              },
            },
          };
        }
        return null;

      case 'attachmentFilename':
      case 'filename':
        if (operator === 'isPresent') {
          return { attachments: { some: {} } };
        }
        if (operator === 'isAbsent') {
          return { attachments: { none: {} } };
        }
        if (operator === 'contains' || operator === 'is') {
          return {
            attachments: {
              some: {
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
                  filename: { contains: strVal, mode: 'insensitive' },
                },
              },
            },
          };
        }
        return null;

      case 'noteContent':
      case 'note':
        if (operator === 'contains' || operator === 'is') {
          return {
            notesList: {
              some: {
                deletedAt: null,
                OR: [
                  { title: { contains: strVal, mode: 'insensitive' } },
                  { contentMd: { contains: strVal, mode: 'insensitive' } },
                ],
              },
            },
          };
        }
        if (operator === 'doesNotContain' || operator === 'isNot') {
          return {
            NOT: {
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
          };
        }
        if (operator === 'isPresent') {
          return {
            notesList: {
              some: { deletedAt: null },
            },
          };
        }
        if (operator === 'isAbsent') {
          return {
            notesList: {
              none: { deletedAt: null },
            },
          };
        }
        return null;

      default: {
        // Direct scalar columns on Item
        if (DIRECT_ITEM_COLUMNS.has(normalizedField)) {
          return this.evalStringField(normalizedField, operator, strVal);
        }

        // Schema extension and metadata field fallback: search in metadata JSONB
        return this.evalJsonField(normalizedField, operator, strVal);
      }
    }
  }

  private evalJsonField(
    jsonKey: string,
    operator: string,
    val: string,
  ): Prisma.ItemWhereInput | null {
    if (operator === 'isPresent') {
      return {
        metadata: {
          path: [jsonKey],
          not: Prisma.JsonNull,
        },
      };
    }
    if (operator === 'isAbsent') {
      return {
        OR: [
          { metadata: { path: [jsonKey], equals: Prisma.JsonNull } },
          { metadata: { path: [jsonKey], equals: '' } },
        ],
      };
    }
    if (operator === 'is') {
      return { metadata: { path: [jsonKey], string_contains: val } };
    }
    if (operator === 'isNot') {
      return { NOT: { metadata: { path: [jsonKey], string_contains: val } } };
    }
    if (operator === 'contains') {
      return { metadata: { path: [jsonKey], string_contains: val } };
    }
    if (operator === 'doesNotContain') {
      return { NOT: { metadata: { path: [jsonKey], string_contains: val } } };
    }
    if (operator === 'beginsWith') {
      return { metadata: { path: [jsonKey], string_starts_with: val } };
    }
    if (operator === 'endsWith') {
      return { metadata: { path: [jsonKey], string_ends_with: val } };
    }
    return null;
  }

  private evalStringField(
    fieldName: string,
    operator: string,
    val: string,
  ): Prisma.ItemWhereInput | null {
    if (operator === 'isPresent') {
      return {
        AND: [{ [fieldName]: { not: null } }, { [fieldName]: { not: '' } }],
      };
    }
    if (operator === 'isAbsent') {
      return {
        OR: [{ [fieldName]: null }, { [fieldName]: '' }],
      };
    }
    if (operator === 'is') {
      return { [fieldName]: { equals: val, mode: 'insensitive' } };
    }
    if (operator === 'isNot') {
      return { NOT: { [fieldName]: { equals: val, mode: 'insensitive' } } };
    }
    if (operator === 'contains') {
      return { [fieldName]: { contains: val, mode: 'insensitive' } };
    }
    if (operator === 'doesNotContain') {
      return { NOT: { [fieldName]: { contains: val, mode: 'insensitive' } } };
    }
    if (operator === 'beginsWith') {
      return { [fieldName]: { startsWith: val, mode: 'insensitive' } };
    }
    if (operator === 'endsWith') {
      return { [fieldName]: { endsWith: val, mode: 'insensitive' } };
    }
    return null;
  }

  private evalDateField(
    fieldName: string,
    operator: SavedSearchOperator,
    value: any,
  ): Prisma.ItemWhereInput | null {
    if (operator === 'isPresent') {
      return { [fieldName]: { not: null } };
    }
    if (operator === 'isAbsent') {
      return { [fieldName]: null };
    }
    if (operator === 'isInTheLast') {
      const cutoff = this.parseRelativeDuration(value);
      if (!cutoff) return null;
      return { [fieldName]: { gte: cutoff } };
    }
    if (operator === 'isBetween' && Array.isArray(value)) {
      const [d1, d2] = value.map((v) => new Date(String(v)));
      if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
        return { [fieldName]: { gte: d1, lte: d2 } };
      }
      return null;
    }
    const strVal = String(value || '').trim();
    const parsedDate = new Date(strVal);
    if (isNaN(parsedDate.getTime())) {
      return null;
    }
    if (operator === 'isGreaterThan') {
      return { [fieldName]: { gt: parsedDate } };
    }
    if (operator === 'isLessThan') {
      return { [fieldName]: { lt: parsedDate } };
    }
    if (operator === 'is') {
      const startOfDay = new Date(parsedDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(parsedDate);
      endOfDay.setHours(23, 59, 59, 999);
      return { [fieldName]: { gte: startOfDay, lte: endOfDay } };
    }
    if (operator === 'isNot') {
      const startOfDay = new Date(parsedDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(parsedDate);
      endOfDay.setHours(23, 59, 59, 999);
      return {
        OR: [
          { [fieldName]: { lt: startOfDay } },
          { [fieldName]: { gt: endOfDay } },
        ],
      };
    }
    return null;
  }

  private parseRelativeDuration(value: any): Date | null {
    let count = 30;
    let unit = 'days';

    if (typeof value === 'object' && value !== null) {
      if (value.count !== undefined) count = Number(value.count);
      if (value.unit) unit = String(value.unit).toLowerCase();
    } else if (typeof value === 'string') {
      const match = value.trim().match(/^(\d+)\s*([a-zA-Z]+)?$/);
      if (match) {
        count = parseInt(match[1], 10);
        if (match[2]) unit = match[2].toLowerCase();
      } else {
        const num = Number(value.trim());
        if (Number.isFinite(num)) count = num;
      }
    } else if (typeof value === 'number') {
      count = value;
    }

    if (!Number.isFinite(count) || count <= 0) {
      return null;
    }

    const now = new Date();
    if (unit.startsWith('d')) {
      return new Date(now.getTime() - count * 86400000);
    }
    if (unit.startsWith('w')) {
      return new Date(now.getTime() - count * 7 * 86400000);
    }
    if (unit.startsWith('m')) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - count);
      return d;
    }
    if (unit.startsWith('y')) {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - count);
      return d;
    }
    return new Date(now.getTime() - count * 86400000);
  }
}
