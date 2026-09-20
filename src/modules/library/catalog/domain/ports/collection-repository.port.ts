/**
 * Collection Repository Port — Domain Layer Interface
 *
 * Defined in the Domain layer (innermost circle).
 * Implemented by the Infrastructure layer (Prisma Adapter).
 * Application Use Cases depend ONLY on this interface — never on Prisma directly.
 */

export const COLLECTION_REPOSITORY_PORT = Symbol('COLLECTION_REPOSITORY_PORT');

/** Data transfer object crossing the port boundary */
export interface CollectionDto {
  id: string;
  userId: string;
  projectId?: string | null;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  parentId?: string | null;
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
  children?: CollectionDto[];
  _count?: { collectionItems: number };
}

export interface CreateCollectionData {
  userId: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
  projectId?: string | null;
}

export interface UpdateCollectionData {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
  version?: number;
}

export interface ICollectionRepositoryPort {
  /**
   * Find a collection by its ID within a user/project scope.
   */
  findById(
    userId: string,
    collectionId: string,
    projectId?: string,
  ): Promise<CollectionDto | null>;

  /**
   * Find all collections for a user or project, returned as flat list.
   */
  findAll(userId: string, projectId?: string): Promise<CollectionDto[]>;

  /**
   * Create a new collection.
   */
  create(data: CreateCollectionData): Promise<CollectionDto>;

  /**
   * Update an existing collection (with optimistic lock via version).
   */
  update(
    userId: string,
    collectionId: string,
    data: UpdateCollectionData,
    projectId?: string,
  ): Promise<CollectionDto>;

  /**
   * Soft-delete a collection. Strategy determines handling of children/items.
   */
  softDelete(
    userId: string,
    collectionId: string,
    projectId?: string,
  ): Promise<void>;

  /**
   * Add items to a collection.
   */
  addItems(collectionId: string, itemIds: string[]): Promise<void>;

  /**
   * Remove items from a collection.
   */
  removeItems(collectionId: string, itemIds: string[]): Promise<void>;
}
