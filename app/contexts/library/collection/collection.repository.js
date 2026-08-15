import CollectionModel from "./collection.schema.js";
import PaperModel from "../paper/paper.schema.js";

export class CollectionRepository {
  constructor() {
    this.model = CollectionModel;
  }

  async findById(id) {
    return this.model.findById(id);
  }

  async findByIdAndWorkspace(id, workspaceId) {
    return this.model.findOne({ _id: id, workspaceId });
  }

  async findByWorkspace(workspaceId) {
    return this.model
      .find({ workspaceId })
      .sort({ createdAt: -1 })
      .lean();
  }

  async existsWithParent(parentId) {
    return this.model.exists({ parent: parentId });
  }

  async hasPapers(collectionId) {
    return PaperModel.exists({ collectionId, deletedAt: null });
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
