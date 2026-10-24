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

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    return rec.deletedAt === null || rec.deletedAt === undefined;
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

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    return typeof rec.itemType === 'string' && this.itemTypes.includes(rec.itemType);
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

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const year = typeof rec.year === 'number' ? rec.year : undefined;
    if (this.yearFrom !== undefined && (year === undefined || year < this.yearFrom)) return false;
    if (this.yearTo !== undefined && (year === undefined || year > this.yearTo)) return false;
    return true;
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

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const list = Array.isArray(rec.collectionItems)
      ? (rec.collectionItems as Array<{ collectionId?: string } | null>)
      : [];
    return list.some((c) => c?.collectionId === this.collectionId);
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

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    const list = Array.isArray(rec.itemTags)
      ? (rec.itemTags as Array<{ tagId?: string } | null>)
      : [];
    return list.some((t) => t?.tagId === this.tagId);
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

  isSatisfiedBy(item: unknown): boolean {
    if (!this.query) return true;
    if (!item || typeof item !== 'object') return false;
    const q = this.query.toLowerCase();
    const rec = item as Record<string, unknown>;
    if (typeof rec.title === 'string' && rec.title.toLowerCase().includes(q)) return true;
    if (typeof rec.abstract === 'string' && rec.abstract.toLowerCase().includes(q)) return true;
    if (typeof rec.doi === 'string' && rec.doi.toLowerCase().includes(q)) return true;
    if (typeof rec.citationKey === 'string' && rec.citationKey.toLowerCase().includes(q)) return true;
    if (Array.isArray(rec.contributors)) {
      const contributors = rec.contributors as Array<{
        fullName?: unknown;
        lastName?: unknown;
      } | null>;
      if (
        contributors.some(
          (c) =>
            (c?.fullName && String(c.fullName).toLowerCase().includes(q)) ||
            (c?.lastName && String(c.lastName).toLowerCase().includes(q)),
        )
      ) {
        return true;
      }
    }
    if (Array.isArray(rec.notesList)) {
      const notesList = rec.notesList as Array<{
        deletedAt?: unknown;
        title?: unknown;
        contentMd?: unknown;
      } | null>;
      if (
        notesList.some(
          (n) =>
            !n?.deletedAt &&
            ((n?.title && String(n.title).toLowerCase().includes(q)) ||
              (n?.contentMd && String(n.contentMd).toLowerCase().includes(q))),
        )
      ) {
        return true;
      }
    }
    if (Array.isArray(rec.attachments)) {
      const attachments = rec.attachments as Array<{
        deletedAt?: unknown;
        annotations?: Array<{
          deletedAt?: unknown;
          quoteText?: unknown;
          comment?: unknown;
        } | null>;
      } | null>;
      if (
        attachments.some(
          (a) =>
            !a?.deletedAt &&
            Array.isArray(a?.annotations) &&
            a.annotations.some(
              (ann) =>
                !ann?.deletedAt &&
                ((ann?.quoteText &&
                  String(ann.quoteText).toLowerCase().includes(q)) ||
                  (ann?.comment && String(ann.comment).toLowerCase().includes(q))),
            ),
        )
      ) {
        return true;
      }
    }
    return false;
  }
}
