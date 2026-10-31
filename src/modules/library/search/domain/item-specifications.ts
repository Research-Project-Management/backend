import {
  ISpecification,
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
  QueryCriteria,
  ScopeSpecification,
  AcademicSearchQueryEngine,
  NormalizedSearchIdentifiers,
  extractSearchQueryIdentifiers,
} from '@/modules/library/core';
import { SearchOptions } from '@/modules/library/search/dto/search.dto';

export {
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
  ScopeSpecification,
  extractSearchQueryIdentifiers,
};
export type { ISpecification, QueryCriteria, NormalizedSearchIdentifiers };

/**
 * Sanitizes search input to prevent SQL injection or tsquery syntax breaking.
 */
export function sanitizeSearchQuery(query?: string): string {
  return AcademicSearchQueryEngine.sanitizeTsQuery(query);
}

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
    return (
      typeof rec.itemType === 'string' && this.itemTypes.includes(rec.itemType)
    );
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
    if (
      this.yearFrom !== undefined &&
      (year === undefined || year < this.yearFrom)
    )
      return false;
    if (this.yearTo !== undefined && (year === undefined || year > this.yearTo))
      return false;
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

    const ids = extractSearchQueryIdentifiers(this.query);
    const orClauses: Record<string, unknown>[] = [
      { title: { contains: this.query, mode: 'insensitive' } },
      { abstract: { contains: this.query, mode: 'insensitive' } },
      { publicationTitle: { contains: this.query, mode: 'insensitive' } },
      { doi: { contains: ids.cleanDoi || this.query, mode: 'insensitive' } },
      { citationKey: { contains: this.query, mode: 'insensitive' } },
      {
        identifiers: {
          some: {
            value: { contains: this.query, mode: 'insensitive' },
          },
        },
      },
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
                    quoteText: {
                      contains: this.query,
                      mode: 'insensitive',
                    },
                  },
                  { comment: { contains: this.query, mode: 'insensitive' } },
                ],
              },
            },
          },
        },
      },
      {
        attachments: {
          some: {
            deletedAt: null,
            filename: { contains: this.query, mode: 'insensitive' },
          },
        },
      },
      {
        attachments: {
          some: {
            deletedAt: null,
            fullTextIndexes: {
              some: {
                textContent: {
                  contains: this.query,
                  mode: 'insensitive',
                },
              },
            },
          },
        },
      },
    ];

    orClauses.push(
      ...AcademicSearchQueryEngine.buildMetadataIdentifierOrClauses(ids),
    );

    return {
      OR: orClauses,
    };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!this.query) return true;
    if (!item || typeof item !== 'object') return false;
    const q = this.query.toLowerCase();
    const ids = extractSearchQueryIdentifiers(this.query);
    const rec = item as Record<string, unknown>;
    if (typeof rec.title === 'string' && rec.title.toLowerCase().includes(q))
      return true;
    if (
      typeof rec.abstract === 'string' &&
      rec.abstract.toLowerCase().includes(q)
    )
      return true;
    if (
      typeof rec.publicationTitle === 'string' &&
      rec.publicationTitle.toLowerCase().includes(q)
    ) {
      return true;
    }
    if (typeof rec.doi === 'string' && rec.doi.toLowerCase().includes(q))
      return true;
    if (
      typeof rec.citationKey === 'string' &&
      rec.citationKey.toLowerCase().includes(q)
    )
      return true;
    if (AcademicSearchQueryEngine.matchesItemIdentifiersInMemory(rec, ids))
      return true;
    if (Array.isArray(rec.identifiers)) {
      const identifiers = rec.identifiers as Array<{ value?: unknown } | null>;
      if (
        identifiers.some(
          (ident) =>
            ident?.value && String(ident.value).toLowerCase().includes(q),
        )
      ) {
        return true;
      }
    }
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
        filename?: unknown;
        annotations?: Array<{
          deletedAt?: unknown;
          quoteText?: unknown;
          comment?: unknown;
        } | null>;
        fullTextIndexes?: Array<{
          textContent?: unknown;
        } | null>;
        fullTextIndex?: Array<{
          textContent?: unknown;
        } | null>;
      } | null>;
      if (
        attachments.some((a) => {
          if (a?.deletedAt) return false;
          const hasFilenameMatch = Boolean(
            a?.filename && String(a.filename).toLowerCase().includes(q),
          );
          const hasAnnotationMatch =
            Array.isArray(a?.annotations) &&
            a.annotations.some(
              (ann) =>
                !ann?.deletedAt &&
                ((ann?.quoteText &&
                  String(ann.quoteText).toLowerCase().includes(q)) ||
                  (ann?.comment &&
                    String(ann.comment).toLowerCase().includes(q))),
            );
          const ftiList = Array.isArray(a?.fullTextIndexes)
            ? a.fullTextIndexes
            : Array.isArray(a?.fullTextIndex)
              ? a.fullTextIndex
              : [];
          const hasFtiMatch = ftiList.some(
            (fti) =>
              fti?.textContent &&
              String(fti.textContent).toLowerCase().includes(q),
          );
          return hasFilenameMatch || hasAnnotationMatch || hasFtiMatch;
        })
      ) {
        return true;
      }
    }
    return false;
  }
}

/**
 * SearchSpecificationBuilder.
 *
 * Fluent factory that translates SearchOptions into a single composable Specification tree.
 */
export class SearchSpecificationBuilder {
  public static fromOptions(
    userId: string,
    options: SearchOptions,
  ): ISpecification {
    let spec = this.baseFromOptions(userId, options);

    if (options.q && options.q.trim()) {
      spec = spec.and(new TextSearchSpecification(options.q.trim()));
    }

    return spec;
  }

  /**
   * Builds structured base specifications excluding the text search query.
   * Useful when full-text search is handled separately via raw PostgreSQL FTS.
   */
  public static baseFromOptions(
    userId: string,
    options: SearchOptions,
  ): ISpecification {
    const scopeSpec = new ScopeSpecification(userId, options.projectId);
    const activeSpec = new ActiveItemsSpecification();
    let spec: ISpecification = scopeSpec.and(activeSpec);

    if (options.itemType) {
      spec = spec.and(new ItemTypeSpecification(options.itemType));
    }

    if (options.yearFrom !== undefined || options.yearTo !== undefined) {
      spec = spec.and(
        new YearRangeSpecification(options.yearFrom, options.yearTo),
      );
    }

    if (options.collectionId) {
      spec = spec.and(new CollectionSpecification(options.collectionId));
    }

    if (options.tagId) {
      spec = spec.and(new TagSpecification(options.tagId));
    }

    return spec;
  }
}
