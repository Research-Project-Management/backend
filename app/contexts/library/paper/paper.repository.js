import PaperModel from "./paper.schema.js";

export class PaperRepository {
  async findByWorkspace(workspaceId) {
    return PaperModel.find({
      workspace: workspaceId,
      deletedAt: null,
    })
      .populate("uploadedBy", "name email avatar")
      .sort({ createdAt: -1 })
      .lean();
  }

  async findByCollection(workspaceId, collectionId) {
    return PaperModel.find({
      workspace: workspaceId,
      collection: collectionId,
      deletedAt: null,
    })
      .populate("uploadedBy", "name email avatar")
      .sort({ createdAt: -1 })
      .lean();
  }


  async findById(paperId, workspaceId = null) {
    const query = { _id: paperId, deletedAt: null };
    if (workspaceId) query.workspace = workspaceId;
    return PaperModel.findOne(query);
  }

  async create(data) {
    return PaperModel.create(data);
  }

  async updateRagStatus(paperId, statusData) {
    return PaperModel.findByIdAndUpdate(paperId, statusData, { new: true });
  }

  async incrementRagAttempts(paperId) {
    return PaperModel.updateOne(
      { _id: paperId },
      {
        ragStatus: "pending",
        ragLastAttemptAt: new Date(),
        $inc: { ragAttempts: 1 },
        $unset: { ragError: "" },
      }
    );
  }

  async softDeleteByCollection(collectionId) {
    return PaperModel.updateMany(
      { collection: collectionId, deletedAt: null },
      { deletedAt: new Date() }
    );
  }
}


