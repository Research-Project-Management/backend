import { AppError } from "../../../lib/AppError.js";

export class CollectionService {
  constructor({ collectionRepository, paperRepository }) {
    this.collectionRepository = collectionRepository;
    this.paperRepository = paperRepository;
  }

  async getCollections(workspaceId) {
    const collections = await this.collectionRepository.findByWorkspace(workspaceId);
    return collections.map((c) => ({
      ...c,
      parent: c.parent ? c.parent.toString() : null,
    }));
  }

  async getCollection(workspaceId, collectionId) {
    const collection = await this.collectionRepository.findByIdAndWorkspace(collectionId, workspaceId);
    if (!collection) throw new AppError("Collection not found", 404);
    return collection;
  }

  async createCollection(workspaceId, userId, dto) {
    if (dto.parent) {
      const parentCol = await this.collectionRepository.findByIdAndWorkspace(dto.parent, workspaceId);
      if (!parentCol) throw new AppError("Parent collection not found", 404);
    }

    return this.collectionRepository.create({
      name: dto.name,
      description: dto.description || "",
      color: dto.color || "#3370ff",
      icon: dto.icon || "",
      workspaceId,
      createdById: userId,
      parent: dto.parent || null,
    });
  }

  async updateCollection(workspaceId, collectionId, dto) {
    const collection = await this.collectionRepository.findByIdAndWorkspace(collectionId, workspaceId);
    if (!collection) throw new AppError("Collection not found", 404);

    if (dto.name !== undefined) collection.name = dto.name;
    if (dto.description !== undefined) collection.description = dto.description;
    if (dto.color !== undefined) collection.color = dto.color;
    if (dto.icon !== undefined) collection.icon = dto.icon;

    if (dto.parent !== undefined) {
      if (dto.parent && dto.parent !== collection.parent?.toString()) {
        const parentCol = await this.collectionRepository.findByIdAndWorkspace(dto.parent, workspaceId);
        if (!parentCol) throw new AppError("Parent collection not found", 404);
        if (dto.parent === collection._id.toString()) {
          throw new AppError("Cannot set collection as its own parent", 400);
        }
      }
      collection.parent = dto.parent || null;
    }

    await this.collectionRepository.save(collection);
    return collection;
  }

  async deleteCollection(workspaceId, collectionId) {
    const collection = await this.collectionRepository.findByIdAndWorkspace(collectionId, workspaceId);
    if (!collection) throw new AppError("Collection not found", 404);

    const hasChildren = await this.collectionRepository.existsWithParent(collection._id);
    if (hasChildren) throw new AppError("Cannot delete collection with sub-collections", 400);

    // Soft-delete all papers belonging to this collection
    if (this.paperRepository?.softDeleteByCollection) {
      await this.paperRepository.softDeleteByCollection(collection._id);
    }

    await this.collectionRepository.delete(collection._id);
  }
}
