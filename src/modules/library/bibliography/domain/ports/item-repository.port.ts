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
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  itemType?: string;
  fromYear?: number;
  toYear?: number;
  readStatus?: string;
  hasFile?: boolean;
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

  /**
   * Purge an item permanently from database.
   */
  purge(userId: string, itemId: string, projectId?: string): Promise<boolean>;

  /**
   * Mark or unmark an item as user's own publication.
   */
  setMyPublication(
    userId: string,
    itemId: string,
    isMyPublication: boolean,
  ): Promise<ItemAggregate | null>;

  /**
   * Get relations for an item.
   */
  getRelations(itemId: string): Promise<any[]>;

  /**
   * Add a relation between two items.
   */
  putRelation(
    sourceItemId: string,
    relation: {
      id: string;
      targetItemId: string;
      relationType: string;
      note?: string;
      linkedAt: string;
    },
  ): Promise<void>;

  /**
   * Remove a relation between two items.
   */
  removeRelation(sourceItemId: string, targetItemId: string): Promise<void>;
}
