import mongoose from "mongoose";

const FLUX_AI_URL = process.env.FLUX_AI_URL || "http://localhost:8000";
const MAX_CHAT_CONTEXT_MESSAGES = 50;
const MAX_AI_MEMORIES = 12;

const normalizeChatMessage = (msg) => {
  if (!msg || typeof msg !== "object") return null;
  const role = msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : null;
  if (!role) return null;
  const content = typeof msg.content === "string" ? msg.content : "";
  if (!content.trim()) return null;
  return { role, content };
};

const getCurrentUserMessage = ({ query, messages }) => {
  if (typeof query === "string" && query.trim()) {
    return { role: "user", content: query.trim() };
  }

  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = normalizeChatMessage(messages[i]);
    if (msg?.role === "user") return msg;
  }
  return null;
};

const sameMessage = (a, b) =>
  a?.role === b?.role && String(a?.content || "") === String(b?.content || "");

const uniqueStrings = (...groups) => {
  const values = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (typeof value === "string" && value.trim()) values.push(value.trim());
    }
  }
  return [...new Set(values)];
};

export class AiService {
  constructor({ aiRepository, chatHistoryRepository, workspaceRepository }) {
    this.aiRepository = aiRepository;
    this.chatHistoryRepository = chatHistoryRepository;
    this.workspaceRepository = workspaceRepository;
  }

  async getChatById(chatId, userId) {
    return this.chatHistoryRepository.findChatById(chatId, userId);
  }

  async loadAiMemoryContext(userId, chat, workspaceId, projectId) {
    const workspace = workspaceId || chat?.workspace || null;
    if (!workspace) return null;

    const resolvedProjectId = projectId || chat?.projectId || null;
    const scopedOr = [{ scope: "workspace" }];
    if (resolvedProjectId) {
      scopedOr.push({ scope: "project", projectId: resolvedProjectId });
    }

    const memories = await this.aiRepository.findMemories(userId, workspace, scopedOr, MAX_AI_MEMORIES);

    return {
      chatSummary: chat?.summary || "",
      keyFacts: Array.isArray(chat?.keyFacts) ? chat.keyFacts.slice(0, 12) : [],
      openQuestions: Array.isArray(chat?.openQuestions)
        ? chat.openQuestions.slice(0, 8)
        : [],
      memories: memories.map((memory) => ({
        type: memory.type,
        scope: memory.scope,
        projectId: memory.projectId || null,
        content: memory.content,
        confidence: memory.confidence,
        updatedAt: memory.updatedAt,
      })),
    };
  }

  async loadChatScopedContext(userId, requestedWorkspace, chatId, query, messages, documentIds) {
    const currentUserMessage = getCurrentUserMessage({ query, messages });

    if (!chatId) {
      const fallbackMessages = Array.isArray(messages)
        ? messages.map(normalizeChatMessage).filter(Boolean)
        : [];
      if (fallbackMessages.length > 0) {
        return { messages: fallbackMessages, chat: null, documentIds: uniqueStrings(documentIds || []) };
      }
      if (currentUserMessage) {
        return { messages: [currentUserMessage], chat: null, documentIds: uniqueStrings(documentIds || []) };
      }
      return { error: { status: 400, message: "Missing 'query' or 'messages'" } };
    }

    if (!mongoose.Types.ObjectId.isValid(chatId)) {
      return { error: { status: 400, message: "Invalid chat_id" } };
    }

    if (!currentUserMessage) {
      return {
        error: {
          status: 400,
          message: "Current user message is required when chat_id is provided",
        },
      };
    }

    const chat = await this.chatHistoryRepository.findChatById(chatId, userId);

    if (!chat) {
      return { error: { status: 404, message: "Chat not found" } };
    }

    if (requestedWorkspace) {
      const queryConds = [];
      if (mongoose.Types.ObjectId.isValid(requestedWorkspace)) {
        queryConds.push({ _id: requestedWorkspace });
      }
      queryConds.push({ url: requestedWorkspace });

      const workspace = await this.workspaceRepository.findOne({ $or: queryConds });
      if (workspace) {
        const matchesId = chat.workspace === workspace._id.toString();
        const matchesUrl = chat.workspace === workspace.url;
        if (!matchesId && !matchesUrl) {
          return { error: { status: 403, message: "Chat does not belong to this workspace" } };
        }
      } else {
        if (chat.workspace !== requestedWorkspace) {
          return { error: { status: 403, message: "Chat does not belong to this workspace" } };
        }
      }
    }

    const persistedMessages = (chat.messages || [])
      .map(normalizeChatMessage)
      .filter(Boolean);
    const scopedMessages = persistedMessages.slice(-MAX_CHAT_CONTEXT_MESSAGES);
    const lastPersisted = scopedMessages.at(-1);

    if (!sameMessage(lastPersisted, currentUserMessage)) {
      scopedMessages.push(currentUserMessage);
    }

    const reqDocumentIds = uniqueStrings(documentIds || []);
    return {
      messages: scopedMessages,
      chat,
      documentIds: reqDocumentIds.length > 0 ? reqDocumentIds : uniqueStrings(chat.documentIds || []),
    };
  }

  async buildFluxBody(userId, body, scopedContext) {
    const memoryContext = await this.loadAiMemoryContext(
      userId,
      scopedContext.chat,
      body.workspace_id,
      body.project_id || scopedContext.chat?.projectId || null
    );

    return {
      messages: scopedContext.messages,
      project_id: body.project_id || scopedContext.chat?.projectId || null,
      document_ids: scopedContext.documentIds?.length ? scopedContext.documentIds : null,
      intent_hint: body.intent_hint || null,
      web_search_sites: body.web_search_sites || null,
      workspace_id: body.workspace_id || scopedContext.chat?.workspace || null,
      user_id: userId,
      chat_id: scopedContext.chat?._id?.toString() || body.chat_id || null,
      
      // LaTeX editor context
      file_content: body.file_content ?? null,
      filename: body.filename ?? null,
      selection: body.selection ?? null,
      cursor_context: body.cursor_context ?? null,
      cursor_line: body.cursor_line ?? null,
      cursor_column: body.cursor_column ?? null,
      selection_start_line: body.selection_start_line ?? null,
      selection_start_column: body.selection_start_column ?? null,
      selection_end_line: body.selection_end_line ?? null,
      selection_end_column: body.selection_end_column ?? null,
      document_structure: body.document_structure ?? null,
      command_hint: body.command_hint ?? null,
      
      memory_context: memoryContext,
    };
  }

  async fetchFluxStream(fluxBody) {
    return fetch(`${FLUX_AI_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(fluxBody),
    });
  }

  async fetchFluxSync(fluxBody) {
    return fetch(`${FLUX_AI_URL}/chat/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fluxBody),
    });
  }

  async fetchDocumentUpload(rawBody, contentType) {
    return fetch(`${FLUX_AI_URL}/documents/upload`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: rawBody,
    });
  }

  async fetchDocumentBulk(ids) {
    return fetch(`${FLUX_AI_URL}/documents/bulk?ids=${encodeURIComponent(ids)}`);
  }

  async fetchDocumentContent(docId) {
    return fetch(`${FLUX_AI_URL}/documents/${encodeURIComponent(docId)}`);
  }

  async fetchDocumentsList() {
    return fetch(`${FLUX_AI_URL}/documents/`);
  }

  async fetchHealth() {
    return fetch(`${FLUX_AI_URL}/health`);
  }
}
