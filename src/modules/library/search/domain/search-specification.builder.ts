import { ISpecification } from './specification.interface';
import {
  ScopeSpecification,
  ActiveItemsSpecification,
  ItemTypeSpecification,
  YearRangeSpecification,
  CollectionSpecification,
  TagSpecification,
  TextSearchSpecification,
} from './item-specifications';
import { SearchOptions } from '@/modules/library/search/types/search.types';

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
    let spec: ISpecification = new ActiveItemsSpecification().and({
      toPrismaWhere: () => scopeSpec.toPrismaWhere(),
      and(other: ISpecification) {
        return new ActiveItemsSpecification().and(this).and(other);
      },
    });

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
