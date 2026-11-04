import {
  ISpecification,
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
  QueryCriteria,
  ScopeSpecification,
  ActiveItemsSpecification,
  TrashItemsSpecification,
  ItemTypeSpecification,
  YearRangeSpecification,
  CollectionSpecification,
  TagSpecification,
  TagNamesSpecification,
  CustomCriteriaSpecification,
  SearchQueryEngine,
  NormalizedSearchIdentifiers,
  extractSearchQueryIdentifiers,
} from '@/modules/library/core';
import { SearchOptions } from '@/modules/library/search/controllers/search.controller';

export {
  CompositeSpecification,
  AndSpecification,
  OrSpecification,
  NotSpecification,
  ScopeSpecification,
  ActiveItemsSpecification,
  TrashItemsSpecification,
  ItemTypeSpecification,
  YearRangeSpecification,
  CollectionSpecification,
  TagSpecification,
  TagNamesSpecification,
  CustomCriteriaSpecification,
  extractSearchQueryIdentifiers,
};
export type { ISpecification, QueryCriteria, NormalizedSearchIdentifiers };

/**
 * Sanitizes search input to prevent SQL injection or tsquery syntax breaking.
 */
export function sanitizeSearchQuery(query?: string): string {
  return SearchQueryEngine.sanitizeTsQuery(query);
}

/**
 * TextSearchSpecification: Comprehensive search across bibliographic metadata,
 * contributors, literature notes, and PDF annotations.
 */
export class TextSearchSpecification extends CompositeSpecification {
  public readonly query: string;
  public readonly searchMode: 'title_creator_year' | 'fields_tags' | 'everything';

  constructor(query: string, searchMode?: string) {
    super();
    this.query = (query ?? '').trim();
    this.searchMode =
      searchMode === 'title_creator_year'
        ? 'title_creator_year'
        : searchMode === 'fields_tags'
          ? 'fields_tags'
          : 'everything';
  }

  toPrismaWhere(): QueryCriteria {
    if (!this.query) return {};
    return {
      OR: SearchQueryEngine.buildComprehensiveItemSearchClauses(
        this.query,
        this.searchMode,
      ),
    };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!this.query) return true;
    if (!item || typeof item !== 'object') return false;
    const q = this.query.toLowerCase();
    const foldedQ = SearchQueryEngine.stripDiacritics(this.query).toLowerCase();
    const matchesText = (val: unknown): boolean => {
      if (!val) return false;
      const str = String(val);
      if (str.toLowerCase().includes(q)) return true;
      return Boolean(
        foldedQ &&
          SearchQueryEngine.stripDiacritics(str).toLowerCase().includes(foldedQ),
      );
    };
    const ids = extractSearchQueryIdentifiers(this.query);
    const rec = item as Record<string, unknown>;
    if (matchesText(rec.title)) return true;
    if (matchesText(rec.abstract)) return true;
    if (matchesText(rec.publicationTitle)) return true;
    if (matchesText(rec.doi)) return true;
    if (matchesText(rec.citationKey)) return true;
    if (SearchQueryEngine.matchesItemIdentifiersInMemory(rec, ids))
      return true;
    if (Array.isArray(rec.identifiers)) {
      const identifiers = rec.identifiers as Array<{ value?: unknown } | null>;
      if (identifiers.some((ident) => matchesText(ident?.value))) {
        return true;
      }
    }
    if (Array.isArray(rec.contributors)) {
      const contributors = rec.contributors as Array<{
        fullName?: unknown;
        lastName?: unknown;
        firstName?: unknown;
      } | null>;
      if (
        contributors.some(
          (c) =>
            matchesText(c?.fullName) ||
            matchesText(c?.lastName) ||
            matchesText(c?.firstName),
        )
      ) {
        return true;
      }
    }
    if (Array.isArray(rec.itemTags)) {
      const itemTags = rec.itemTags as Array<{
        tag?: { name?: unknown } | null;
      } | null>;
      if (itemTags.some((it) => matchesText(it?.tag?.name))) {
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
            (matchesText(n?.title) || matchesText(n?.contentMd)),
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
          const hasFilenameMatch = matchesText(a?.filename);
          const hasAnnotationMatch =
            Array.isArray(a?.annotations) &&
            a.annotations.some(
              (ann) =>
                !ann?.deletedAt &&
                (matchesText(ann?.quoteText) || matchesText(ann?.comment)),
            );
          const ftiList = Array.isArray(a?.fullTextIndexes)
            ? a.fullTextIndexes
            : Array.isArray(a?.fullTextIndex)
              ? a.fullTextIndex
              : [];
          const hasFtiMatch = ftiList.some((fti) =>
            matchesText(fti?.textContent),
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
      spec = spec.and(
        new TextSearchSpecification(options.q.trim(), options.searchMode),
      );
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
    const view = options.view ?? 'all';
    const scopeSpec = new ScopeSpecification(userId, options.projectId);
    const lifecycleSpec =
      view === 'trash'
        ? new TrashItemsSpecification()
        : new ActiveItemsSpecification();
    let spec: ISpecification = scopeSpec.and(lifecycleSpec);

    if (view === 'unfiled') {
      spec = spec.and(
        new CustomCriteriaSpecification({
          collectionItems: { none: { collection: { deletedAt: null } } },
        }),
      );
    } else if (view === 'starred') {
      spec = spec.and(
        new CustomCriteriaSpecification({
          states: { some: { userId, isStarred: true } },
        }),
      );
    } else if (view === 'my-publications' || view === 'publications') {
      spec = spec.and(
        new CustomCriteriaSpecification({
          OR: [
            { metadata: { path: ['isMyPublication'], equals: true } },
            { publications: { some: { userId } } },
          ],
        }),
      );
    } else if (view === 'retracted') {
      spec = spec.and(
        new CustomCriteriaSpecification({
          OR: [
            { isRetracted: true },
            { metadata: { path: ['isRetracted'], equals: true } },
          ],
        }),
      );
    }

    if (options.isRetracted !== undefined && view !== 'retracted') {
      if (options.isRetracted) {
        spec = spec.and(
          new CustomCriteriaSpecification({
            OR: [
              { isRetracted: true },
              { metadata: { path: ['isRetracted'], equals: true } },
            ],
          }),
        );
      } else {
        spec = spec.and(
          new CustomCriteriaSpecification({
            NOT: {
              OR: [
                { isRetracted: true },
                { metadata: { path: ['isRetracted'], equals: true } },
              ],
            },
          }),
        );
      }
    }

    if (options.onlyFlagged && view !== 'starred') {
      spec = spec.and(
        new CustomCriteriaSpecification({
          states: { some: { userId, isStarred: true } },
        }),
      );
    }

    const effectiveType = options.itemType || options.type;
    if (effectiveType) {
      spec = spec.and(new ItemTypeSpecification(effectiveType));
    }

    const effectiveYearFrom = options.yearFrom ?? options.fromYear;
    const effectiveYearTo = options.yearTo ?? options.toYear;
    if (
      (effectiveYearFrom !== undefined && effectiveYearFrom !== null) ||
      (effectiveYearTo !== undefined && effectiveYearTo !== null)
    ) {
      spec = spec.and(
        new YearRangeSpecification(effectiveYearFrom, effectiveYearTo),
      );
    }

    if (options.hasFile !== undefined) {
      spec = spec.and(
        new CustomCriteriaSpecification({ hasFile: options.hasFile }),
      );
    }

    if (options.hasNotes !== undefined) {
      spec = spec.and(
        new CustomCriteriaSpecification(
          options.hasNotes ? { noteCount: { gt: 0 } } : { noteCount: 0 },
        ),
      );
    }

    if (options.readStatus && options.readStatus !== 'all') {
      const validStatuses = ['unread', 'reading', 'completed'];
      const statuses = options.readStatus
        .split(',')
        .map((s) => (s.trim() === 'read' ? 'completed' : s.trim()))
        .filter((s) => validStatuses.includes(s));
      if (statuses.length > 0) {
        if (statuses.includes('unread')) {
          spec = spec.and(
            new CustomCriteriaSpecification({
              OR: [
                { states: { none: { userId } } },
                {
                  states: {
                    some: {
                      userId,
                      readStatus:
                        statuses.length > 1 ? { in: statuses } : 'unread',
                    },
                  },
                },
              ],
            }),
          );
        } else {
          spec = spec.and(
            new CustomCriteriaSpecification({
              states: {
                some: {
                  userId,
                  readStatus:
                    statuses.length > 1 ? { in: statuses } : statuses[0],
                },
              },
            }),
          );
        }
      }
    }

    const targetCollectionIds =
      options.targetCollectionIds || options.collectionIds;
    if (targetCollectionIds && targetCollectionIds.length > 0) {
      spec = spec.and(new CollectionSpecification(targetCollectionIds));
    } else if (options.collectionId) {
      spec = spec.and(new CollectionSpecification(options.collectionId));
    }

    if (options.tagId) {
      spec = spec.and(new TagSpecification(options.tagId));
    }

    if (options.tag) {
      spec = spec.and(new TagNamesSpecification(options.tag));
    }

    return spec;
  }
}
