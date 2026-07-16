export class CollectionService {
  constructor({ collectionRepository }) {
    this.collectionRepository = collectionRepository;
  }

  async getCollections(workspaceId) {
    const collections = await this.collectionRepository.findByWorkspace(workspaceId);
    const countMap = await this.collectionRepository.getPaperCounts(workspaceId, collections.map(c => c._id));

    return collections.map((c) => ({
      ...c,
      parent: c.parent ? c.parent.toString() : null,
      paperCount: countMap.get(c._id.toString()) ?? 0,
    }));
  }

  async createCollection(workspaceId, userId, dto) {
    if (!dto.name) throw new Error("Collection name is required");

    if (dto.parent) {
      const parentCol = await this.collectionRepository.findById(dto.parent, workspaceId);
      if (!parentCol) throw new Error("Parent collection not found");
    }

    return this.collectionRepository.create({
      name: dto.name,
      description: dto.description || "",
      color: dto.color || "#3370ff",
      icon: dto.icon || "",
      workspace: workspaceId,
      createdBy: userId,
      parent: dto.parent || null,
    });
  }

  async updateCollection(workspaceId, collectionId, dto) {
    const collection = await this.collectionRepository.findById(collectionId, workspaceId);
    if (!collection) throw new Error("Collection not found");

    if (dto.name !== undefined) collection.name = dto.name;
    if (dto.description !== undefined) collection.description = dto.description;
    if (dto.color !== undefined) collection.color = dto.color;
    if (dto.icon !== undefined) collection.icon = dto.icon;
    if (dto.parent !== undefined) {
      if (dto.parent && dto.parent !== collection.parent?.toString()) {
        const parentCol = await this.collectionRepository.findById(dto.parent, workspaceId);
        if (!parentCol) throw new Error("Parent collection not found");
        if (dto.parent === collection._id.toString()) throw new Error("Cannot set collection as its own parent");
      }
      collection.parent = dto.parent || null;
    }

    await collection.save();
    return collection;
  }

  async deleteCollection(workspaceId, collectionId) {
    const collection = await this.collectionRepository.findById(collectionId, workspaceId);
    if (!collection) throw new Error("Collection not found");

    const hasChildren = await this.collectionRepository.existsWithParent(collection._id);
    if (hasChildren) throw new Error("Cannot delete collection with sub-collections");

    const hasPapers = await this.collectionRepository.hasPapers(collection._id);
    if (hasPapers) throw new Error("Cannot delete collection containing papers");

    await collection.deleteOne();
  }
}

