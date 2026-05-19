/**
 * Chat History Routes — CRUD for persisted AI chat sessions.
 *
 * Mounted at /api/ai (alongside the existing proxy route).
 *
 * GET    /api/ai/chats?workspaceId=      — list sessions for a workspace
 * POST   /api/ai/chats                   — create a new session
 * GET    /api/ai/chats/:chatId           — fetch a session with its messages
 * PATCH  /api/ai/chats/:chatId/messages  — append messages to a session
 * PATCH  /api/ai/chats/:chatId/title     — rename a session title
 * DELETE /api/ai/chats/:chatId           — delete a session
 *
 * Per-page routes (LaTeX editor AI panel):
 * GET    /api/ai/chats/page/:pageId      — load (or auto-create) chat for a page
 * DELETE /api/ai/chats/page/:pageId      — clear chat history for a page
 */

import { Router } from "express";
import ChatHistoryModel from "../schema/chatHistory.js";
import AiMemoryModel from "../schema/aiMemory.js";

const chatHistoryRouter = Router();
const FLUX_AI_URL = process.env.FLUX_AI_URL || "http://localhost:8000";

const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: "Unauthorized" });
};

const getUserId = (req) => req.user._id.toString();

const clampStrings = (value, limit) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).slice(0, limit)
    : [];

const refreshChatMemory = async (chatId, userId) => {
  try {
    const chat = await ChatHistoryModel.findOne({ _id: chatId, user: userId }).lean();
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
    await ChatHistoryModel.findOneAndUpdate(
      { _id: chatId, user: userId },
      {
        $set: {
          summary: typeof update.summary === "string" ? update.summary : "",
          keyFacts: clampStrings(update.key_facts, 16),
          openQuestions: clampStrings(update.open_questions, 10),
        },
      },
    );

    const memories = Array.isArray(update.memories) ? update.memories : [];
    for (const memory of memories.slice(0, 8)) {
      const content = typeof memory.content === "string" ? memory.content.trim() : "";
      if (!content) continue;

      const scope = memory.scope === "project" && chat.projectId ? "project" : "workspace";
      const type = [
        "project_summary",
        "workspace_summary",
        "preference",
        "decision",
        "entity",
        "constraint",
      ].includes(memory.type)
        ? memory.type
        : scope === "project"
          ? "project_summary"
          : "workspace_summary";

      await AiMemoryModel.findOneAndUpdate(
        {
          user: userId,
          workspace: chat.workspace,
          projectId: scope === "project" ? chat.projectId : null,
          scope,
          type,
          content,
        },
        {
          $set: {
            confidence:
              typeof memory.confidence === "number"
                ? Math.max(0, Math.min(1, memory.confidence))
                : 0.7,
            sourceChatId: chat._id.toString(),
          },
        },
        { upsert: true, new: true },
      );
    }
  } catch (err) {
    console.error("Chat memory refresh failed:", err.message);
  }
};

/**
 * GET /api/ai/chats?workspaceId=<id>
 * Returns a lightweight list (no message bodies) for the sidebar.
 */
chatHistoryRouter.get("/chats", isAuthenticated, async (req, res) => {
  const { workspaceId } = req.query;
  if (!workspaceId) {
    return res.status(400).json({ error: "workspaceId query param required" });
  }

  try {
    const chats = await ChatHistoryModel.find({
      workspace: workspaceId,
      user: getUserId(req),
    })
      .select("_id title messages updatedAt createdAt projectId")
      .sort({ updatedAt: -1 })
      .lean();

    // Include only the last message as a preview — keep payload small
    const result = chats.map((c) => ({
      _id: c._id,
      title: c.title,
      projectId: c.projectId,
      messageCount: c.messages.length,
      lastMessage: c.messages.at(-1)?.content?.slice(0, 120) || "",
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
    }));

    res.json({ chats: result });
  } catch (err) {
    console.error("ChatHistory list error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai/chats
 * Body: { workspaceId, title?, messages?, projectId? }
 * Creates and returns the new chat session.
 */
chatHistoryRouter.post("/chats", isAuthenticated, async (req, res) => {
  const { workspaceId, title, messages, projectId, documentIds } = req.body;
  if (!workspaceId) {
    return res.status(400).json({ error: "workspaceId is required" });
  }

  try {
    const chat = await ChatHistoryModel.create({
      workspace: workspaceId,
      user: getUserId(req),
      title: title?.trim() || "New Chat",
      messages: Array.isArray(messages) ? messages : [],
      projectId: projectId || null,
      documentIds: Array.isArray(documentIds) ? documentIds : [],
    });

    res.status(201).json({ chat });
  } catch (err) {
    console.error("ChatHistory create error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ai/chats/page/:pageId?workspaceId=
 *
 * Load the AI chat session for a specific LaTeX editor page.
 * Auto-creates the session if one doesn't exist yet for this user+page.
 * Returns the full session including all messages (last 50).
 *
 * IMPORTANT: This route must be declared BEFORE /chats/:chatId so that
 * Express does not match "page" as a chatId parameter.
 */
chatHistoryRouter.get("/chats/page/:pageId", isAuthenticated, async (req, res) => {
  const { pageId } = req.params;
  const { workspaceId } = req.query;

  if (!workspaceId) {
    return res.status(400).json({ error: "workspaceId query param required" });
  }

  try {
    const userId = getUserId(req);

    let chat = await ChatHistoryModel.findOne({ pageId, user: userId }).lean();

    if (!chat) {
      chat = await ChatHistoryModel.create({
        workspace: workspaceId,
        user: userId,
        title: `Page ${pageId}`,
        messages: [],
        projectId: null,
        documentIds: [],
        pageId,
      });
      chat = chat.toObject();
    }

    const recentMessages = (chat.messages || []).slice(-50);
    res.json({ chat: { ...chat, messages: recentMessages } });
  } catch (err) {
    console.error("ChatHistory page get error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/ai/chats/page/:pageId
 * Clear all messages from the AI chat for a specific page.
 */
chatHistoryRouter.delete("/chats/page/:pageId", isAuthenticated, async (req, res) => {
  const { pageId } = req.params;
  try {
    const userId = getUserId(req);
    const chat = await ChatHistoryModel.findOneAndUpdate(
      { pageId, user: userId },
      { $set: { messages: [] } },
      { new: true },
    );
    if (!chat) {
      return res.status(404).json({ error: "Chat not found for this page" });
    }
    res.json({ message: "Chat history cleared", chatId: chat._id });
  } catch (err) {
    console.error("ChatHistory page clear error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/ai/chats/:chatId
 * Returns the full session including all messages.
 */
chatHistoryRouter.get("/chats/:chatId", isAuthenticated, async (req, res) => {
  try {
    const chat = await ChatHistoryModel.findOne({
      _id: req.params.chatId,
      user: getUserId(req),
    }).lean();

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    res.json({ chat });
  } catch (err) {
    console.error("ChatHistory get error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/ai/chats/:chatId/messages
 * Body: { messages: [{ role, content }] }
 * Appends new messages to the history.
 */
chatHistoryRouter.patch(
  "/chats/:chatId/messages",
  isAuthenticated,
  async (req, res) => {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json({ error: "messages array (non-empty) required" });
    }

    const { documentIds } = req.body;
    const update = { $push: { messages: { $each: messages } } };
    // If the caller passes documentIds (new files uploaded in this exchange), persist them.
    if (Array.isArray(documentIds) && documentIds.length > 0) {
      update.$addToSet = { documentIds: { $each: documentIds } };
    }

    try {
      const chat = await ChatHistoryModel.findOneAndUpdate(
        { _id: req.params.chatId, user: getUserId(req) },
        update,
        { new: true },
      );

      if (!chat) {
        return res.status(404).json({ error: "Chat not found" });
      }

      const userId = getUserId(req);
      refreshChatMemory(req.params.chatId, userId);

      res.json({ chat });
    } catch (err) {
      console.error("ChatHistory append error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * PATCH /api/ai/chats/:chatId/title
 * Body: { title }
 * Renames a chat session.
 */
chatHistoryRouter.patch(
  "/chats/:chatId/title",
  isAuthenticated,
  async (req, res) => {
    const { title } = req.body;
    if (!title?.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    try {
      const chat = await ChatHistoryModel.findOneAndUpdate(
        { _id: req.params.chatId, user: getUserId(req) },
        { title: title.trim() },
        { new: true },
      );

      if (!chat) {
        return res.status(404).json({ error: "Chat not found" });
      }

      res.json({ chat });
    } catch (err) {
      console.error("ChatHistory rename error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * DELETE /api/ai/chats/:chatId
 *
 * Deletes the chat session from MongoDB and removes all associated
 * Qdrant document chunks from Flux-AI (per-session RAG isolation).
 */
chatHistoryRouter.delete(
  "/chats/:chatId",
  isAuthenticated,
  async (req, res) => {
    try {
      const chat = await ChatHistoryModel.findOneAndDelete({
        _id: req.params.chatId,
        user: getUserId(req),
      });

      if (!chat) {
        return res.status(404).json({ error: "Chat not found" });
      }

      // Fire-and-forget: delete all Qdrant chunks scoped to this chat session.
      // We do not await so the client gets a fast response even if Flux-AI is slow.
      const FLUX_AI_URL =
        process.env.FLUX_AI_URL || "http://localhost:8000";
      const userId = getUserId(req);
      const chatId = req.params.chatId;

      fetch(
        `${FLUX_AI_URL}/documents/by-chat/${encodeURIComponent(chatId)}?user_id=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ).catch((err) =>
        console.error(
          "Flux-AI document cleanup error for chat %s: %s",
          chatId,
          err.message,
        ),
      );

      res.json({ message: "Chat deleted" });
    } catch (err) {
      console.error("ChatHistory delete error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

export default chatHistoryRouter;

