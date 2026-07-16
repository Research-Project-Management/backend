import ChatHistoryModel from "./chat-history.schema.js";

export class ChatHistoryRepository {
  constructor() {
    this.model = ChatHistoryModel;
  }
  findByUser(userId) { return this.model.find({ user: userId }).sort({ createdAt: -1 }).limit(100); }
  findByWorkspaceAndUser(workspaceId, userId) {
    return this.model.find({ workspace: workspaceId, user: userId })
      .select("_id title messages updatedAt createdAt projectId")
      .sort({ updatedAt: -1 })
      .lean();
  }
  findOne(query) { return this.model.findOne(query); }
  findOneAndUpdate(query, update, options = {}) { return this.model.findOneAndUpdate(query, update, options); }
  findOneAndDelete(query) { return this.model.findOneAndDelete(query); }
  findByIdAndUser(id, userId) { return this.model.findOne({ _id: id, user: userId }).lean(); }
  create(data) { return this.model.create(data); }
  deleteById(id, userId) { return this.model.findOneAndDelete({ _id: id, user: userId }); }
}



