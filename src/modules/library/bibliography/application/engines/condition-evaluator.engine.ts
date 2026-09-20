import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SavedSearchCondition,
  SavedSearchConditionGroup,
  isConditionGroup,
} from '../../domain/types/saved-search.types';

@Injectable()
export class ConditionEvaluatorEngine {
  /**
   * Translates a SavedSearchConditionGroup AST into a Prisma ItemWhereInput query.
   * Scopes to projectId when specified (collaborative library) or userId (personal library).
   */
  compile(
    userId: string,
    group: SavedSearchConditionGroup,
    projectId?: string,
  ): Prisma.ItemWhereInput {
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

    const compiledGroup = this.evaluateGroup(group, userId);

    return {
      AND: [baseWhere, compiledGroup],
    };
  }

  private evaluateGroup(
    group: SavedSearchConditionGroup,
    userId?: string,
  ): Prisma.ItemWhereInput {
    const clauses: Prisma.ItemWhereInput[] = [];

    for (const item of group.conditions) {
      if (isConditionGroup(item)) {
        clauses.push(this.evaluateGroup(item, userId));
      } else {
        const leafClause = this.evaluateCondition(item, userId);
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
  ): Prisma.ItemWhereInput | null {
    const { field, operator, value } = cond;
    const strVal =
      value !== undefined && value !== null ? String(value).trim() : '';

    switch (field) {
      case 'title':
        return this.evalStringField('title', operator, strVal);

      case 'abstract':
        return this.evalStringField('abstract', operator, strVal);

      case 'publicationTitle':
        return this.evalStringField('publicationTitle', operator, strVal);

      case 'doi':
        return this.evalStringField('doi', operator, strVal);

      case 'isbn':
        return this.evalStringField('isbn', operator, strVal);

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
          return { itemType: { not: null } };
        }
        if (operator === 'isAbsent') {
          return { itemType: null };
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

      case 'collection':
        if (operator === 'isPresent') {
          return { collectionItems: { some: {} } };
        }
        if (operator === 'isAbsent') {
          return { collectionItems: { none: {} } };
        }
        if (operator === 'is') {
          return { collectionItems: { some: { collectionId: strVal } } };
        }
        if (operator === 'isNot') {
          return {
            NOT: { collectionItems: { some: { collectionId: strVal } } },
          };
        }
        return null;

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

      case 'dateAdded': {
        if (operator === 'isPresent') {
          return { createdAt: { not: undefined } };
        }
        if (operator === 'isAbsent') {
          return null;
        }
        if (operator === 'isBetween' && Array.isArray(value)) {
          const [d1, d2] = value.map((v) => new Date(String(v)));
          if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
            return { createdAt: { gte: d1, lte: d2 } };
          }
          return null;
        }
        const parsedDate = new Date(strVal);
        if (isNaN(parsedDate.getTime())) {
          return null;
        }
        if (operator === 'isGreaterThan') {
          return { createdAt: { gt: parsedDate } };
        }
        if (operator === 'isLessThan') {
          return { createdAt: { lt: parsedDate } };
        }
        return null;
      }

      default:
        return null;
    }
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
}
