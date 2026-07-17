export class ProjectCollectionService {
  constructor({ projectCollectionRepository, collectionRepository, paperRepository }) {
    this.projectCollectionRepository = projectCollectionRepository;
    this.collectionRepository = collectionRepository;
    this.paperRepository = paperRepository;
  }

  async getProjectCollections(projectId) {
    return this.projectCollectionRepository.findByProject(projectId);
  }

  async createProjectCollection(projectId, workspaceId, userId, dto) {
    if (!dto.name) throw new Error("Collection name is required");

    return this.projectCollectionRepository.create({
      name: dto.name,
      description: dto.description || "",
      project: projectId,
      workspace: workspaceId,
      createdBy: userId,
      papers: [],
    });
  }

  async importLibraryCollectionToExisting(projectId, workspaceId, userId, pcId, collectionId) {
    if (!collectionId) throw new Error("collectionId is required");

    const libCollection = await this.collectionRepository.findById(collectionId, workspaceId);
    if (!libCollection) throw new Error("Library collection not found");

    const pc = await this.projectCollectionRepository.findById(pcId, projectId);
    if (!pc) throw new Error("Project collection not found");

    // Fetch papers from the paperRepository
    // We only need IDs, but for simplicity we get full objects and map them
    // Or we could have added findByCollection in paperRepository. We will just use findByWorkspace.
    // However, finding by collection is more efficient. We will assume the paperRepository has findByWorkspace and we can filter.
    // Actually, I will just call findByWorkspace and filter manually.
    const allPapers = await this.paperRepository.findByWorkspace(workspaceId);
    const papersInCol = allPapers.filter(p => p.collection?.toString() === libCollection._id.toString());

    const existingIds = new Set(pc.papers.map((p) => p.paper.toString()));
    const toAdd = papersInCol
      .filter((p) => !existingIds.has(p._id.toString()))
      .map((p) => ({
        paper: p._id,
        addedBy: userId,
        note: "",
        addedAt: new Date(),
      }));

    if (toAdd.length > 0) {
      pc.papers.push(...toAdd);
      pc.sourceCollection = libCollection._id;
      await this.projectCollectionRepository.save(pc);
    }

    return { added: toAdd.length, projectCollection: pc };
  }

  async addPaperToProjectCollection(projectId, workspaceId, userId, pcId, dto) {
    if (!dto.paperId) throw new Error("paperId is required");

    const paper = await this.paperRepository.findById(dto.paperId, workspaceId);
    if (!paper) throw new Error("Paper not found");

    const pc = await this.projectCollectionRepository.findById(pcId, projectId);
    if (!pc) throw new Error("Project collection not found");

    const alreadyAdded = pc.papers.some((p) => (p.paper._id ? p.paper._id.toString() : p.paper.toString()) === dto.paperId);
    if (alreadyAdded) throw new Error("Paper already in this collection");

    pc.papers.push({
      paper: paper._id,
      addedBy: userId,
      note: dto.note || "",
      addedAt: new Date(),
    });
    await this.projectCollectionRepository.save(pc);
    return pc;
  }

  async removePaperFromProjectCollection(projectId, pcId, paperId) {
    const pc = await this.projectCollectionRepository.findById(pcId, projectId);
    if (!pc) throw new Error("Project collection not found");

    pc.papers = pc.papers.filter((p) => (p.paper._id ? p.paper._id.toString() : p.paper.toString()) !== paperId);
    await this.projectCollectionRepository.save(pc);
  }

  async deleteProjectCollection(projectId, pcId) {
    await this.projectCollectionRepository.delete(pcId, projectId);
  }
}

