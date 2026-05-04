/**
 * AI Proxy Route — forwards authenticated AI requests to Flux-AI backend.
 *
 * All /api/ai/* requests go through RPM-BE's auth middleware first,
 * then get proxied to the Flux-AI server.
 */

import { Router } from "express";
import { isAuthenticated } from "../middleware/checkWorkspaceRole.js";

const aiRouter = Router();

const FLUX_AI_URL = process.env.FLUX_AI_URL || "http://localhost:8000";

/**
 * Optional auth — attaches user if session exists, but doesn't block.
 */
const optionalAuth = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  // Allow unauthenticated in dev, block in production
  if (process.env.NODE_ENV === "production") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

/**
 * POST /api/ai/chat
 * Proxy chat requests to Flux-AI with SSE streaming
 */
aiRouter.post("/chat", isAuthenticated, async (req, res) => {
  try {
    const {
      query,
      session_id,
      enable_web_search,
      selected_files,
      document_ids,
      messages,
      intent_hint,
      project_id,
      web_search_sites,
      chat_id,
    } = req.body;

    // Build Flux-AI compatible request
    let fluxMessages;
    if (messages && Array.isArray(messages)) {
      fluxMessages = messages;
    } else if (query) {
      fluxMessages = [{ role: "user", content: query }];
    } else {
      return res.status(400).json({ error: "Missing 'query' or 'messages'" });
    }

    const fluxBody = {
      messages: fluxMessages,
      project_id: project_id || null,
      // Accept both field names: FE sends document_ids, legacy clients may send selected_files
      document_ids: document_ids || selected_files || null,
      intent_hint: intent_hint || null,
      web_search_sites: web_search_sites || null,
      // Agent context — inject user identity for action agent
      workspace_id: req.body.workspace_id || null,
      user_id: req.user._id.toString(),
      // RAG isolation — scope retrieval to this chat session
      chat_id: chat_id || null,
      // ── LaTeX editor context (forwarded as-is from frontend) ───────────────
      file_content: req.body.file_content ?? null,
      filename: req.body.filename ?? null,
      selection: req.body.selection ?? null,
      cursor_context: req.body.cursor_context ?? null,
      // Cursor position
      cursor_line: req.body.cursor_line ?? null,
      cursor_column: req.body.cursor_column ?? null,
      // Selection range
      selection_start_line: req.body.selection_start_line ?? null,
      selection_start_column: req.body.selection_start_column ?? null,
      selection_end_line: req.body.selection_end_line ?? null,
      selection_end_column: req.body.selection_end_column ?? null,
      // Document structure summary & slash command
      document_structure: req.body.document_structure ?? null,
      command_hint: req.body.command_hint ?? null,
    };

    // Forward to Flux-AI with streaming
    const fluxResponse = await fetch(`${FLUX_AI_URL}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(fluxBody),
    });

    if (!fluxResponse.ok) {
      const errText = await fluxResponse.text();
      console.error("Flux-AI error:", fluxResponse.status, errText);
      return res
        .status(fluxResponse.status)
        .json({ error: "AI service error" });
    }

    // Set SSE headers and force-flush immediately
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Transfer-Encoding": "chunked",
    });

    // Disable Nagle's algorithm — send each write immediately
    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setTimeout(0);
    }

    // Pipe the Flux-AI response body directly to Express response
    // Using Readable.fromWeb() converts Web ReadableStream → Node.js Readable
    const { Readable } = await import("stream");
    const nodeStream = Readable.fromWeb(fluxResponse.body);

    nodeStream.on("data", (chunk) => {
      res.write(chunk);
    });

    nodeStream.on("end", () => {
      res.end();
    });

    nodeStream.on("error", (err) => {
      console.error("Stream pipe error:", err);
      res.end();
    });

    // Handle client disconnect
    req.on("close", () => {
      nodeStream.destroy();
    });
  } catch (error) {
    console.error("AI Proxy Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to connect to AI service" });
    }
  }
});

/**
 * POST /api/ai/chat/sync
 * Non-streaming chat — returns full response at once
 */
aiRouter.post("/chat/sync", isAuthenticated, async (req, res) => {
  try {
    const {
      query,
      messages,
      intent_hint,
      project_id,
      selected_files,
      document_ids,
    } = req.body;

    let fluxMessages;
    if (messages && Array.isArray(messages)) {
      fluxMessages = messages;
    } else if (query) {
      fluxMessages = [{ role: "user", content: query }];
    } else {
      return res.status(400).json({ error: "Missing 'query' or 'messages'" });
    }

    const fluxBody = {
      messages: fluxMessages,
      project_id: project_id || null,
      document_ids: document_ids || selected_files || null,
      intent_hint: intent_hint || null,
    };

    const fluxResponse = await fetch(`${FLUX_AI_URL}/chat/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fluxBody),
    });

    if (!fluxResponse.ok) {
      const errText = await fluxResponse.text();
      console.error("Flux-AI sync error:", fluxResponse.status, errText);
      return res
        .status(fluxResponse.status)
        .json({ error: "AI service error" });
    }

    const data = await fluxResponse.json();
    res.json(data);
  } catch (error) {
    console.error("AI Sync Proxy Error:", error);
    res.status(500).json({ error: "Failed to connect to AI service" });
  }
});

/**
 * Build extra MIME text-field parts to append to an existing multipart body.
 *
 * @param {string} boundary   - The multipart boundary (without leading --)
 * @param {Record<string,string>} fields - Key/value pairs to add
 * @returns {Buffer}
 */
function _buildExtraFields(boundary, fields) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        value,
    );
  }
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * Inject extra form fields into a raw multipart/form-data Buffer.
 * Inserts the new parts just before the closing `--boundary--` marker.
 *
 * Returns the original body unchanged if the boundary cannot be parsed.
 *
 * @param {Buffer} rawBody
 * @param {string} contentType  - Value of the Content-Type header
 * @param {Record<string,string>} fields
 * @returns {Buffer}
 */
function _injectMultipartFields(rawBody, contentType, fields) {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) return rawBody;

  const boundary = boundaryMatch[1].replace(/^"|"$/g, ""); // strip optional quotes
  const endMarker = Buffer.from(`\r\n--${boundary}--`);

  // Find the LAST occurrence of the closing boundary
  let endIdx = -1;
  for (let i = rawBody.length - endMarker.length; i >= 0; i--) {
    if (rawBody.slice(i, i + endMarker.length).equals(endMarker)) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) return rawBody; // malformed — pass through unchanged

  const prefix = rawBody.slice(0, endIdx);
  const extra = _buildExtraFields(boundary, fields);
  return Buffer.concat([prefix, extra, endMarker]);
}

/**
 * POST /api/ai/documents/upload?chatId=<chatId>
 * Proxy document uploads to Flux-AI.
 *
 * Injects `user_id` (from authenticated session) and `chat_id` (from ?chatId
 * query param) into the multipart body so Flux-AI can scope the RAG chunks
 * to this user/session only.
 */
aiRouter.post("/documents/upload", isAuthenticated, async (req, res) => {
  try {
    const chatId = req.query.chatId || req.body?.chatId || "";
    const userId = req.user._id.toString();

    // Collect raw multipart body — express.json() does NOT consume it.
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    let rawBody = Buffer.concat(chunks);

    const contentType = req.headers["content-type"] || "";

    // Inject user_id + chat_id BEFORE the closing boundary so Flux-AI stores
    // them in Qdrant metadata for per-session isolation.
    rawBody = _injectMultipartFields(rawBody, contentType, {
      user_id: userId,
      chat_id: chatId,
    });

    const fluxResponse = await fetch(`${FLUX_AI_URL}/documents/upload`, {
      method: "POST",
      headers: {
        "content-type": contentType,
      },
      body: rawBody,
    });

    if (!fluxResponse.ok) {
      const errText = await fluxResponse.text();
      console.error("Flux-AI upload error:", fluxResponse.status, errText);
      return res.status(fluxResponse.status).json({ error: "Upload failed" });
    }

    const data = await fluxResponse.json();
    res.json(data);
  } catch (error) {
    console.error("Document Upload Proxy Error:", error);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

/**
 * GET /api/ai/documents/bulk?ids=id1,id2,...
 * Resolve titles/types for multiple doc IDs (used to restore filenames after history load)
 */
aiRouter.get("/documents/bulk", isAuthenticated, async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.status(400).json({ error: "Missing ids parameter" });
    const fluxResponse = await fetch(
      `${FLUX_AI_URL}/documents/bulk?ids=${encodeURIComponent(ids)}`,
    );
    if (!fluxResponse.ok) {
      return res
        .status(fluxResponse.status)
        .json({ error: "Failed to fetch document metadata" });
    }
    const data = await fluxResponse.json();
    res.json(data);
  } catch (error) {
    console.error("Document Bulk Metadata Error:", error);
    res.status(500).json({ error: "Failed to fetch document metadata" });
  }
});

/**
 * GET /api/ai/documents/:docId
 * Fetch full reconstructed content of a single document
 */
aiRouter.get("/documents/:docId", isAuthenticated, async (req, res) => {
  try {
    const { docId } = req.params;
    const fluxResponse = await fetch(
      `${FLUX_AI_URL}/documents/${encodeURIComponent(docId)}`,
    );
    if (!fluxResponse.ok) {
      return res
        .status(fluxResponse.status)
        .json({ error: "Document not found" });
    }
    const data = await fluxResponse.json();
    res.json(data);
  } catch (error) {
    console.error("Document Content Error:", error);
    res.status(500).json({ error: "Failed to fetch document content" });
  }
});

/**
 * GET /api/ai/documents
 * List ingested documents
 */
aiRouter.get("/documents", isAuthenticated, async (req, res) => {
  try {
    const fluxResponse = await fetch(`${FLUX_AI_URL}/documents/`);
    if (!fluxResponse.ok) {
      return res
        .status(fluxResponse.status)
        .json({ error: "Failed to list documents" });
    }
    const data = await fluxResponse.json();
    res.json(data);
  } catch (error) {
    console.error("Document List Proxy Error:", error);
    res.status(500).json({ error: "Failed to list documents" });
  }
});

/**
 * GET /api/ai/health
 * Check Flux-AI health
 */
aiRouter.get("/health", async (req, res) => {
  try {
    const fluxResponse = await fetch(`${FLUX_AI_URL}/health`);
    if (!fluxResponse.ok) {
      return res.status(503).json({ status: "unavailable" });
    }
    const data = await fluxResponse.json();
    res.json(data);
  } catch (error) {
    res
      .status(503)
      .json({ status: "unavailable", error: "Cannot reach AI service" });
  }
});

export default aiRouter;
