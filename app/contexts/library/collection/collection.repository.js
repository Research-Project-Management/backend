import CollectionModel from "./collection.schema.js";
import PaperModel from "../paper/paper.schema.js";

export class CollectionRepository {
  async findByWorkspace(workspaceId) {
    return CollectionModel.find({ workspace: workspaceId })
      .populate("createdBy", "name email avatar")
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(collectionId, workspaceId) {
    return CollectionModel.findOne({ _id: collectionId, workspace: workspaceId });
  }

  async create(data) {
    return CollectionModel.create(data);
  }

  async existsWithParent(parentId) {
    return CollectionModel.exists({ parent: parentId });
  }

  async getPaperCounts(workspaceId, collectionIds) {
    const counts = await PaperModel.aggregate([
      {
        $match: {
          workspace: workspaceId,
          deletedAt: null,
          collection: { $in: collectionIds },
        },
      },
      { $group: { _id: "$collection", count: { $sum: 1 } } },
    ]);
    return new Map(counts.map((c) => [c._id.toString(), c.count]));
  }

  async hasPapers(collectionId) {
    return PaperModel.exists({ collection: collectionId, deletedAt: null });
  }
}

