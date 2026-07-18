import { AppError } from "../../../lib/AppError.js";

const FLUX_AI_URL = process.env.FLUX_AI_URL || "http://localhost:8000";

const clampStrings = (value, limit) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).slice(0, limit)
    : [];

export class ChatHistoryService {
  constructor({ chatHistoryRepository, aiRepository }) {
    this.chatHistoryRepository = chatHistoryRepository;
    this.aiRepository = aiRepository;
  }

  async getChats(workspaceId, userId) {
    if (!workspaceId) throw new AppError("workspaceId query param required", 400);
    const chats = await this.chatHistoryRepository.findChatsByWorkspace(workspaceId, userId);
    
    return chats.map((c) => ({
      _id: c._id,
      title: c.title,
      projectId: c.projectId,
      documentIds: c.documentIds || [],
      messageCount: c.messages.length,
      lastMessage: c.messages.at(-1)?.content?.slice(0, 120) || "",
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
    }));
  }

  async createChat(userId, { workspaceId, title, messages, projectId, documentIds }) {
    if (!workspaceId) throw new AppError("workspaceId is required", 400);
    return this.chatHistoryRepository.createChat({
      workspace: workspaceId,
      user: userId,
      title: title?.trim() || "New Chat",
      messages: Array.isArray(messages) ? messages : [],
      projectId: projectId || null,
      documentIds: Array.isArray(documentIds) ? documentIds : [],
    });
  }

  async getPageChat(pageId, workspaceId, userId) {
    if (!workspaceId) throw new AppError("workspaceId query param required", 400);
    
    let chat = await this.chatHistoryRepository.findChatByPage(pageId, userId);
    
    if (!chat) {
      const newChat = await this.chatHistoryRepository.createChat({
        workspace: workspaceId,
        user: userId,
        title: `Page ${pageId}`,
        messages: [],
        projectId: null,
        documentIds: [],
        pageId,
      });
      chat = newChat.toObject ? newChat.toObject() : newChat;
    }
    
    const recentMessages = (chat.messages || []).slice(-50);
    return { ...chat, messages: recentMessages };
  }

  async clearPageChat(pageId, userId) {
    const chat = await this.chatHistoryRepository.clearPageMessages(pageId, userId);
    if (!chat) throw new AppError("Chat not found for this page", 404);
    return { message: "Chat history cleared", chatId: chat._id };
  }

  async getChat(chatId, userId) {
    const chat = await this.chatHistoryRepository.findChatById(chatId, userId);
    if (!chat) throw new AppError("Chat not found", 404);
    return chat;
  }

  async appendMessages(chatId, userId, { messages, documentIds }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AppError("messages array (non-empty) required", 400);
    }
    
    const chat = await this.chatHistoryRepository.appendMessages(chatId, userId, messages, documentIds);
    if (!chat) throw new AppError("Chat not found", 404);
    
    this.refreshChatMemory(chatId, userId).catch(err => console.error("refreshChatMemory failed:", err));
    return chat;
  }

  async renameChat(chatId, userId, { title }) {
    if (!title?.trim()) throw new AppError("title is required", 400);
    const chat = await this.chatHistoryRepository.updateTitle(chatId, userId, title);
    if (!chat) throw new AppError("Chat not found", 404);
    return chat;
  }

  async deleteChat(chatId, userId) {
    const chat = await this.chatHistoryRepository.deleteChat(chatId, userId);
    if (!chat) throw new AppError("Chat not found", 404);
    
    fetch(`${FLUX_AI_URL}/documents/by-chat/${encodeURIComponent(chatId)}?user_id=${encodeURIComponent(userId)}`, { 
      method: "DELETE" 
    }).catch((err) =>
      console.error("Flux-AI document cleanup error for chat %s: %s", chatId, err.message)
    );
    
    return { message: "Chat deleted" };
  }

  async clearMemory(workspaceId, userId) {
    if (!workspaceId) throw new AppError("workspaceId is required", 400);
    await this.aiRepository.deleteMemoriesByWorkspace(workspaceId, userId);
    await this.chatHistoryRepository.clearSummarizedFields(workspaceId, userId);
    return { message: "AI Memory cleared successfully" };
  }

  async refreshChatMemory(chatId, userId) {
    try {
      const chat = await this.chatHistoryRepository.findChatById(chatId, userId);
      if (!chat || (chat.messages || []).length < 4) return;
  
      const response = await fetch(`${FLUX_AI_URL}/memory/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat._id.toString(),
          user_id: userId,
          workspace_id: chat.workspace,
          project_id: chat.projectId || null,
          existing_summary: chat.summary || "",
          existing_key_facts: chat.keyFacts || [],
          existing_open_questions: chat.openQuestions || [],
          messages: (chat.messages || []).slice(-30).map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        }),
      });
  
      if (!response.ok) {
        const errorText = await response.text();
        console.error("Flux-AI memory update error:", response.status, errorText);
        return;
      }
  
      const update = await response.json();
      await this.chatHistoryRepository.updateSummarizedFields(
        chatId, 
        userId, 
        typeof update.summary === "string" ? update.summary : "",
        clampStrings(update.key_facts, 16),
        clampStrings(update.open_questions, 10)
      );
  
      const memories = Array.isArray(update.memories) ? update.memories : [];
      for (const memory of memories.slice(0, 8)) {
        const content = typeof memory.content === "string" ? memory.content.trim() : "";
        if (!content) continue;
  
        const scope = memory.scope === "project" && chat.projectId ? "project" : "workspace";
        const type = ["project_summary", "workspace_summary", "preference", "decision", "entity", "constraint"].includes(memory.type)
          ? memory.type
          : scope === "project" ? "project_summary" : "workspace_summary";
  
        await this.aiRepository.upsertMemory(
          userId, 
          chat.workspace, 
          scope === "project" ? chat.projectId : null, 
          scope, 
          type, 
          content,
          typeof memory.confidence === "number" ? Math.max(0, Math.min(1, memory.confidence)) : 0.7,
          chat._id.toString()
        );
      }
    } catch (err) {
      console.error("Chat memory refresh failed:", err.message);
    }
  }
}
