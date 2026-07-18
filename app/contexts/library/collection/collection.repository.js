import { CollectionModel, WorkspaceCollectionModel, ProjectCollectionModel } from "./collection.schema.js";
import PaperModel from "../paper/paper.schema.js";

// ── Base Repository ──────────────────────────────────────────────────────────
export class CollectionRepository {
  constructor(model) {
    this.model = model || CollectionModel;
  }

  async findById(id) {
    return this.model.findById(id);
  }

  async create(data) {
    return this.model.create(data);
  }

  async save(doc) {
    return doc.save();
  }

  async delete(id) {
    return this.model.findByIdAndDelete(id);
  }
}

// ── Workspace Collection Repository ───────────────────────────────────────────
export class WorkspaceCollectionRepository extends CollectionRepository {
  constructor() {
    super(WorkspaceCollectionModel);
  }

  async findByIdAndWorkspace(id, workspaceId) {
    return this.model.findOne({ _id: id, workspaceId: workspaceId });
  }

  async findByWorkspace(workspaceId) {
    return this.model.find({ workspaceId: workspaceId })
      .sort({ createdAt: -1 })
      .lean();
  }

  async existsWithParent(parentId) {
    return this.model.exists({ parent: parentId });
  }

  async getPaperCounts(workspaceId, collectionIds) {
    const counts = await PaperModel.aggregate([
      {
        $match: {
          workspaceId: workspaceId, // ensure we are within the workspace
          deletedAt: null,
          collectionId: { $in: collectionIds.map(id => id.toString()) },
        },
      },
      { $group: { _id: "$collectionId", count: { $sum: 1 } } },
    ]);
    return new Map(counts.map((c) => [c._id.toString(), c.count]));
  }

  async hasPapers(collectionId) {
    return PaperModel.exists({ collectionId: collectionId.toString(), deletedAt: null });
  }
}

// ── Project Collection Repository ─────────────────────────────────────────────
export class ProjectCollectionRepository extends CollectionRepository {
  constructor() {
    super(ProjectCollectionModel);
  }

  async findByIdAndProject(pcId, projectId) {
    return this.model.findOne({ _id: pcId, projectId: projectId });
  }

  async findByProject(projectId) {
    return this.model.find({ projectId: projectId })
      .populate("sourceCollection", "name color icon")
      .populate({
        path: "papers.paper",
        match: { deletedAt: null },
        select: "title authors year doi filename mimeType fileUrl size ragDocId ragStatus ragIndexedAt",
      })
      .sort({ createdAt: -1 })
      .lean();
  }
}
