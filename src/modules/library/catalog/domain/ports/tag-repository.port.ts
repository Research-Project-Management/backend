/**
 * Tag Repository Port — Domain Layer Interface
 *
 * Defined in the Domain layer (innermost circle).
 * Implemented by the Infrastructure layer (Prisma Adapter).
 * Application Use Cases depend ONLY on this interface — never on Prisma directly.
 */

export const TAG_REPOSITORY_PORT = Symbol('TAG_REPOSITORY_PORT');

/** Raw data transfer object used across the port boundary */
export interface TagDto {
  id: string;
  userId: string;
  projectId?: string | null;
  name: string;
  color: string;
  type: string;
  createdAt?: Date;
  _count?: { itemTags: number };
}

export interface FindTagsOptions {
  includeInactive?: boolean;
  projectId?: string;
}

export interface CreateTagOptions {
  color?: string;
  type?: string;
  projectId?: string | null;
}

export interface ITagRepositoryPort {
  /**
   * Find all tags belonging to a user or project scope.
   */
  findMany(userId: string, options?: FindTagsOptions): Promise<TagDto[]>;

  /**
   * Find a single tag by name within a user scope.
   */
  findByName(userId: string, name: string): Promise<TagDto | null>;

  /**
   * Create or upsert a tag by name. Returns the existing tag if it already exists.
   */
  createOrGet(
    userId: string,
    name: string,
    options?: CreateTagOptions,
  ): Promise<TagDto>;

  /**
   * Delete a tag by ID. Returns true if the tag was deleted.
   */
  delete(userId: string, tagId: string): Promise<boolean>;

  /**
   * Assign a tag to an item (upsert join record).
   */
  assignToItem(tagId: string, itemId: string): Promise<void>;

  /**
   * Remove a tag from an item.
   */
  removeFromItem(tagId: string, itemId: string): Promise<void>;
}
