import { AppError } from "../../../lib/AppError.js";

export class ChatHistoryService {
  constructor({ chatHistoryRepository }) {
    this.chatHistoryRepository = chatHistoryRepository;
  }

  getHistory(userId) { return this.chatHistoryRepository.findByUser(userId); }
  addHistory(userId, data) { return this.chatHistoryRepository.create({ ...data, user: userId }); }
  deleteHistory(id, userId) { return this.chatHistoryRepository.deleteById(id, userId); }

  async getChats(workspaceId, userId) {
    const chats = await this.chatHistoryRepository.findByWorkspaceAndUser(workspaceId, userId);
    return chats.map((c) => ({
      _id: c._id,
      title: c.title,
      projectId: c.projectId,
      messageCount: c.messages.length,
      lastMessage: c.messages.at(-1)?.content?.slice(0, 120) || "",
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
    }));
  }

  async createChat(userId, { workspaceId, title, messages, projectId, documentIds }) {
    return this.chatHistoryRepository.create({
      workspace: workspaceId,
      user: userId,
      title: title?.trim() || "New Chat",
      messages: Array.isArray(messages) ? messages : [],
      projectId: projectId || null,
      documentIds: Array.isArray(documentIds) ? documentIds : [],
    });
  }

  async getPageChat(pageId, workspaceId, userId) {
    let chat = await this.chatHistoryRepository.findOne({ pageId, user: userId });
    if (!chat) {
      chat = await this.chatHistoryRepository.create({
        workspace: workspaceId,
        user: userId,
        title: `Page ${pageId}`,
        messages: [],
        projectId: null,
        documentIds: [],
        pageId,
      });
    }
    const raw = chat.toObject ? chat.toObject() : chat;
    const recentMessages = (raw.messages || []).slice(-50);
    return { ...raw, messages: recentMessages };
  }

  async clearPageChat(pageId, userId) {
    const chat = await this.chatHistoryRepository.findOneAndUpdate(
      { pageId, user: userId },
      { $set: { messages: [] } },
      { new: true }
    );
    if (!chat) throw new AppError("Chat not found for this page", 404);
    return { chatId: chat._id };
  }

  async getChat(chatId, userId) {
    const chat = await this.chatHistoryRepository.findByIdAndUser(chatId, userId);
    if (!chat) throw new AppError("Chat not found", 404);
    return chat;
  }

  async appendMessages(chatId, userId, { messages, documentIds }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AppError("messages array (non-empty) required", 400);
    }
    const update = { $push: { messages: { $each: messages } } };
    if (Array.isArray(documentIds) && documentIds.length > 0) {
      update.$addToSet = { documentIds: { $each: documentIds } };
    }
    const chat = await this.chatHistoryRepository.findOneAndUpdate(
      { _id: chatId, user: userId },
      update,
      { new: true }
    );
    if (!chat) throw new AppError("Chat not found", 404);
    return chat;
  }

  async renameChat(chatId, userId, { title }) {
    if (!title?.trim()) throw new AppError("title is required", 400);
    const chat = await this.chatHistoryRepository.findOneAndUpdate(
      { _id: chatId, user: userId },
      { title: title.trim() },
      { new: true }
    );
    if (!chat) throw new AppError("Chat not found", 404);
    return chat;
  }

  async deleteChat(chatId, userId) {
    const chat = await this.chatHistoryRepository.findOneAndDelete({ _id: chatId, user: userId });
    if (!chat) throw new AppError("Chat not found", 404);

    // Fire-and-forget: delete all Qdrant chunks scoped to this chat session.
    const FLUX_AI_URL = process.env.FLUX_AI_URL || "http://localhost:8000";
    fetch(
      `${FLUX_AI_URL}/documents/by-chat/${encodeURIComponent(chatId)}?user_id=${encodeURIComponent(userId)}`,
      { method: "DELETE" }
    ).catch((err) =>
      console.error("Flux-AI document cleanup error for chat %s: %s", chatId, err.message)
    );
    return { message: "Chat deleted" };
  }
}
