import ChatHistoryModel from "./chat-history.schema.js";

export class ChatHistoryRepository {
  constructor() {
    this.model = ChatHistoryModel;
  }

  async findChatsByWorkspace(workspaceId, userId) {
    return this.model.find({
      workspace: workspaceId,
      user: userId,
    })
      .select("_id title messages updatedAt createdAt projectId documentIds")
      .sort({ updatedAt: -1 })
      .lean();
  }

  async createChat(data) {
    return this.model.create(data);
  }

  async findChatByPage(pageId, userId) {
    return this.model.findOne({ pageId, user: userId }).lean();
  }

  async clearPageMessages(pageId, userId) {
    return this.model.findOneAndUpdate(
      { pageId, user: userId },
      { $set: { messages: [] } },
      { new: true }
    );
  }

  async findChatById(chatId, userId) {
    return this.model.findOne({
      _id: chatId,
      user: userId,
    }).lean();
  }

  async appendMessages(chatId, userId, messages, documentIds) {
    const update = { $push: { messages: { $each: messages } } };
    if (Array.isArray(documentIds) && documentIds.length > 0) {
      update.$addToSet = { documentIds: { $each: documentIds } };
    }

    return this.model.findOneAndUpdate(
      { _id: chatId, user: userId },
      update,
      { new: true }
    );
  }

  async updateTitle(chatId, userId, title) {
    return this.model.findOneAndUpdate(
      { _id: chatId, user: userId },
      { title: title.trim() },
      { new: true }
    );
  }

  async deleteChat(chatId, userId) {
    return this.model.findOneAndDelete({
      _id: chatId,
      user: userId,
    });
  }

  async clearSummarizedFields(workspaceId, userId) {
    return this.model.updateMany(
      { workspace: workspaceId, user: userId },
      {
        $set: {
          summary: "",
          keyFacts: [],
          openQuestions: [],
        },
      }
    );
  }

  async updateSummarizedFields(chatId, userId, summary, keyFacts, openQuestions) {
    return this.model.findOneAndUpdate(
      { _id: chatId, user: userId },
      {
        $set: {
          summary,
          keyFacts,
          openQuestions,
        },
      }
    );
  }
}
