import { ItemAggregate } from '../model/item.aggregate';

export const ITEM_REPOSITORY_PORT = Symbol('ITEM_REPOSITORY_PORT');

export interface FindManyItemsOptions {
  view?: string;
  collectionId?: string;
  tagId?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  projectId?: string;
}

export interface PaginatedItemsResult {
  items: ItemAggregate[];
  totalCount: number;
  nextCursor?: string;
  hasNextPage: boolean;
}

export interface IItemRepositoryPort {
  /**
   * Save an aggregate (insert or update based on version).
   */
  save(aggregate: ItemAggregate): Promise<void>;

  /**
   * Find an aggregate by ID within a tenant/project scope.
   */
  findById(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<ItemAggregate | null>;

  /**
   * Find multiple aggregates by query criteria.
   */
  findMany(
    userId: string,
    options: FindManyItemsOptions,
  ): Promise<PaginatedItemsResult>;

  /**
   * Delete an aggregate permanently or soft-delete.
   */
  delete(userId: string, itemId: string, projectId?: string): Promise<void>;
}
