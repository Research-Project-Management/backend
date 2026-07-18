import PaperModel from "./paper.schema.js";

export class PaperRepository {
  async findByWorkspace(workspaceId) {
    return PaperModel.find({
      workspaceId: workspaceId,
      deletedAt: null,
    })
      .populate("uploadedBy", "name email avatar")
      .sort({ createdAt: -1 })
      .lean();
  }

  async findByCollection(workspaceId, collectionId) {
    return PaperModel.find({
      workspaceId: workspaceId,
      collectionId: collectionId,
      deletedAt: null,
    })
      .populate("uploadedBy", "name email avatar")
      .sort({ createdAt: -1 })
      .lean();
  }


  async findById(paperId, workspaceId = null) {
    const query = { _id: paperId, deletedAt: null };
    if (workspaceId) query.workspaceId = workspaceId;
    return PaperModel.findOne(query).populate("uploadedBy", "name email avatar").populate("collection", "name");
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
      { collectionId: collectionId, deletedAt: null },
      { deletedAt: new Date() }
    );
  }
}


