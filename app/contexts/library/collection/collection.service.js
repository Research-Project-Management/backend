import { AppError } from "../../../lib/AppError.js";

// ── Base Collection Service ───────────────────────────────────────────────────
export class CollectionService {
  constructor(repository) {
    this.repository = repository;
  }

  // ── Abstract Domain Methods (Interface) ──────────────────────────────────────
  async getCollections(...args) { throw new AppError("Method getCollections not implemented", 500); }
  async getCollection(...args) { throw new AppError("Method getCollection not implemented", 500); }
  async createCollection(...args) { throw new AppError("Method createCollection not implemented", 500); }
  async updateCollection(...args) { throw new AppError("Method updateCollection not implemented", 500); }
  async deleteCollection(...args) { throw new AppError("Method deleteCollection not implemented", 500); }
}

// ── Workspace Collection Service ──────────────────────────────────────────────
export class WorkspaceCollectionService extends CollectionService {
  constructor({ workspaceCollectionRepository, paperRepository }) {
    super(workspaceCollectionRepository);
    this.paperRepository = paperRepository;
  }

  async getCollections(workspaceId) {
    const collections = await this.repository.findByWorkspace(workspaceId);
    const countMap = await this.repository.getPaperCounts(workspaceId, collections.map(c => c._id));

    return collections.map((c) => ({
      ...c,
      parent: c.parent ? c.parent.toString() : null,
      paperCount: countMap.get(c._id.toString()) ?? 0,
    }));
  }

  async getCollection(workspaceId, collectionId) {
    const collection = await this.repository.findByIdAndWorkspace(collectionId, workspaceId);
    if (!collection) throw new AppError("Collection not found", 404);
    return collection;
  }

  async createCollection(workspaceId, userId, dto) {
    if (!dto.name) throw new AppError("Collection name is required", 400);

    if (dto.parent) {
      const parentCol = await this.repository.findByIdAndWorkspace(dto.parent, workspaceId);
      if (!parentCol) throw new AppError("Parent collection not found", 404);
    }

    return this.repository.create({
      name: dto.name,
      description: dto.description || "",
      color: dto.color || "#3370ff",
      icon: dto.icon || "",
      workspaceId: workspaceId,
      createdById: userId,
      parent: dto.parent || null,
    });
  }

  async updateCollection(workspaceId, collectionId, dto) {
    const collection = await this.repository.findByIdAndWorkspace(collectionId, workspaceId);
    if (!collection) throw new AppError("Collection not found", 404);

    if (dto.name !== undefined) collection.name = dto.name;
    if (dto.description !== undefined) collection.description = dto.description;
    if (dto.color !== undefined) collection.color = dto.color;
    if (dto.icon !== undefined) collection.icon = dto.icon;
    
    if (dto.parent !== undefined) {
      if (dto.parent && dto.parent !== collection.parent?.toString()) {
        const parentCol = await this.repository.findByIdAndWorkspace(dto.parent, workspaceId);
        if (!parentCol) throw new AppError("Parent collection not found", 404);
        if (dto.parent === collection._id.toString()) throw new AppError("Cannot set collection as its own parent", 400);
      }
      collection.parent = dto.parent || null;
    }

    await this.repository.save(collection);
    return collection;
  }

  async deleteCollection(workspaceId, collectionId) {
    const collection = await this.repository.findByIdAndWorkspace(collectionId, workspaceId);
    if (!collection) throw new AppError("Collection not found", 404);

    const hasChildren = await this.repository.existsWithParent(collection._id);
    if (hasChildren) throw new AppError("Cannot delete collection with sub-collections", 400);

    // Soft-delete all papers in this collection
    if (this.paperRepository && this.paperRepository.softDeleteByCollection) {
      await this.paperRepository.softDeleteByCollection(collection._id);
    }

    await this.repository.delete(collection._id);
  }
}

// ── Project Collection Service ────────────────────────────────────────────────
export class ProjectCollectionService extends CollectionService {
  constructor({ projectCollectionRepository, workspaceCollectionRepository, paperRepository }) {
    super(projectCollectionRepository);
    this.workspaceCollectionRepository = workspaceCollectionRepository;
    this.paperRepository = paperRepository;
  }

  async getCollections(projectId) {
    return this.repository.findByProject(projectId);
  }

  async createCollection(projectId, workspaceId, userId, dto) {
    if (!dto.name) throw new AppError("Collection name is required", 400);

    return this.repository.create({
      name: dto.name,
      description: dto.description || "",
      projectId: projectId,
      workspaceId: workspaceId,
      createdById: userId,
      papers: [],
    });
  }

  async importLibraryCollectionToExisting(projectId, workspaceId, userId, pcId, collectionId) {
    if (!collectionId) throw new AppError("collectionId is required", 400);

    const libCollection = await this.workspaceCollectionRepository.findByIdAndWorkspace(collectionId, workspaceId);
    if (!libCollection) throw new AppError("Library collection not found", 404);

    const pc = await this.repository.findByIdAndProject(pcId, projectId);
    if (!pc) throw new AppError("Project collection not found", 404);

    const papersInCol = await this.paperRepository.findByCollection(workspaceId, libCollection._id);

    const existingIds = new Set(pc.papers.map((p) => p.paper.toString()));
    const toAdd = papersInCol
      .filter((p) => !existingIds.has(p._id.toString()))
      .map((p) => ({
        paper: p._id,
        addedById: userId,
        note: "",
        addedAt: new Date(),
      }));

    if (toAdd.length > 0) {
      pc.papers.push(...toAdd);
      pc.sourceCollection = libCollection._id;
      await this.repository.save(pc);
    }

    return { added: toAdd.length, projectCollection: pc };
  }

  async addPaperToProjectCollection(projectId, workspaceId, userId, pcId, dto) {
    if (!dto.paperId) throw new AppError("paperId is required", 400);

    const paper = await this.paperRepository.findById(dto.paperId, workspaceId);
    if (!paper) throw new AppError("Paper not found", 404);

    const pc = await this.repository.findByIdAndProject(pcId, projectId);
    if (!pc) throw new AppError("Project collection not found", 404);

    const alreadyAdded = pc.papers.some((p) => (p.paper._id ? p.paper._id.toString() : p.paper.toString()) === dto.paperId);
    if (alreadyAdded) throw new AppError("Paper already in this collection", 400);

    pc.papers.push({
      paper: paper._id,
      addedById: userId,
      note: dto.note || "",
      addedAt: new Date(),
    });
    
    await this.repository.save(pc);
    return pc;
  }

  async removePaperFromProjectCollection(projectId, pcId, paperId) {
    const pc = await this.repository.findByIdAndProject(pcId, projectId);
    if (!pc) throw new AppError("Project collection not found", 404);

    pc.papers = pc.papers.filter((p) => (p.paper._id ? p.paper._id.toString() : p.paper.toString()) !== paperId);
    await this.repository.save(pc);
  }

  async deleteCollection(projectId, collectionId) {
    const pc = await this.repository.findByIdAndProject(collectionId, projectId);
    if (!pc) throw new AppError("Project collection not found", 404);
    await this.repository.delete(collectionId);
  }
}
