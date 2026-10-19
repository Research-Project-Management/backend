import {
  CompositeSpecification,
  QueryCriteria,
} from './specification.interface';
import { ScopeSpecification } from '@/modules/library/core';

export { CompositeSpecification, ScopeSpecification };
export type { QueryCriteria };

/**
 * ActiveItemsSpecification: Filters out soft-deleted items.
 */
export class ActiveItemsSpecification extends CompositeSpecification {
  toPrismaWhere(): QueryCriteria {
    return { deletedAt: null };
  }
}

/**
 * ItemTypeSpecification: Filters by bibliographic item type (journalArticle, book, etc.).
 */
export class ItemTypeSpecification extends CompositeSpecification {
  private readonly itemTypes: string[];

  constructor(itemTypes: string | string[]) {
    super();
    this.itemTypes = Array.isArray(itemTypes) ? itemTypes : [itemTypes];
  }

  toPrismaWhere(): QueryCriteria {
    if (this.itemTypes.length === 1) {
      return { itemType: this.itemTypes[0] };
    }
    return { itemType: { in: this.itemTypes } };
  }
}

/**
 * YearRangeSpecification: Filters by publication year range [yearFrom, yearTo].
 */
export class YearRangeSpecification extends CompositeSpecification {
  constructor(
    public readonly yearFrom?: number,
    public readonly yearTo?: number,
  ) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    const yearFilter: Record<string, unknown> = {};
    if (this.yearFrom !== undefined) yearFilter.gte = this.yearFrom;
    if (this.yearTo !== undefined) yearFilter.lte = this.yearTo;
    return { year: yearFilter };
  }
}

/**
 * CollectionSpecification: Filters by collection membership.
 */
export class CollectionSpecification extends CompositeSpecification {
  constructor(public readonly collectionId: string) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    return {
      collectionItems: {
        some: { collectionId: this.collectionId },
      },
    };
  }
}

/**
 * TagSpecification: Filters by tag membership.
 */
export class TagSpecification extends CompositeSpecification {
  constructor(public readonly tagId: string) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    return {
      itemTags: {
        some: { tagId: this.tagId },
      },
    };
  }
}

/**
 * TextSearchSpecification: Comprehensive search across bibliographic metadata,
 * contributors, literature notes, and PDF annotations.
 */
export class TextSearchSpecification extends CompositeSpecification {
  public readonly query: string;

  constructor(query: string) {
    super();
    this.query = (query ?? '').trim();
  }

  toPrismaWhere(): QueryCriteria {
    if (!this.query) return {};

    return {
      OR: [
        { title: { contains: this.query, mode: 'insensitive' } },
        { abstract: { contains: this.query, mode: 'insensitive' } },
        { doi: { contains: this.query, mode: 'insensitive' } },
        { citationKey: { contains: this.query, mode: 'insensitive' } },
        {
          contributors: {
            some: {
              OR: [
                { fullName: { contains: this.query, mode: 'insensitive' } },
                { lastName: { contains: this.query, mode: 'insensitive' } },
              ],
            },
          },
        },
        {
          notesList: {
            some: {
              deletedAt: null,
              OR: [
                { title: { contains: this.query, mode: 'insensitive' } },
                { contentMd: { contains: this.query, mode: 'insensitive' } },
              ],
            },
          },
        },
        {
          attachments: {
            some: {
              deletedAt: null,
              annotations: {
                some: {
                  deletedAt: null,
                  OR: [
                    {
                      quoteText: { contains: this.query, mode: 'insensitive' },
                    },
                    { comment: { contains: this.query, mode: 'insensitive' } },
                  ],
                },
              },
            },
          },
        },
      ],
    };
  }
}

