import { asyncHandler } from "../../../lib/asyncHandler.js";
import { Readable } from "stream";

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

function _injectMultipartFields(rawBody, contentType, fields) {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) return rawBody;

  const boundary = boundaryMatch[1].replace(/^"|"$/g, "");
  const endMarker = Buffer.from(`\r\n--${boundary}--`);

  let endIdx = -1;
  for (let i = rawBody.length - endMarker.length; i >= 0; i--) {
    if (rawBody.slice(i, i + endMarker.length).equals(endMarker)) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) return rawBody;

  const prefix = rawBody.slice(0, endIdx);
  const extra = _buildExtraFields(boundary, fields);
  return Buffer.concat([prefix, extra, endMarker]);
}

export class AiController {
  constructor({ aiService }) {
    this.aiService = aiService;

    this.chatStream = asyncHandler(async (req, res) => {
      const { query, messages, selected_files, document_ids, chat_id } = req.body;
      const userId = req.user._id.toString();

      const scopedContext = await this.aiService.loadChatScopedContext(
        userId,
        req.body.workspace_id,
        chat_id,
        query,
        messages,
        document_ids || selected_files
      );

      if (scopedContext.error) {
        return res.status(scopedContext.error.status).json({ error: scopedContext.error.message });
      }

      const fluxBody = await this.aiService.buildFluxBody(userId, req.body, scopedContext);
      const fluxResponse = await this.aiService.fetchFluxStream(fluxBody);

      if (!fluxResponse.ok) {
        const errText = await fluxResponse.text();
        console.error("Flux-AI error:", fluxResponse.status, errText);
        return res.status(fluxResponse.status).json({ error: "AI service error" });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Transfer-Encoding": "chunked",
      });

      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setTimeout(0);
      }

      const nodeStream = Readable.fromWeb(fluxResponse.body);
      nodeStream.on("data", (chunk) => res.write(chunk));
      nodeStream.on("end", () => res.end());
      nodeStream.on("error", (err) => {
        console.error("Stream pipe error:", err);
        res.end();
      });

      req.on("close", () => {
        nodeStream.destroy();
      });
    });

    this.chatSync = asyncHandler(async (req, res) => {
      const { query, messages, selected_files, document_ids, chat_id } = req.body;
      const userId = req.user._id.toString();

      const scopedContext = await this.aiService.loadChatScopedContext(
        userId,
        req.body.workspace_id,
        chat_id,
        query,
        messages,
        document_ids || selected_files
      );

      if (scopedContext.error) {
        return res.status(scopedContext.error.status).json({ error: scopedContext.error.message });
      }

      const fluxBody = await this.aiService.buildFluxBody(userId, req.body, scopedContext);
      const fluxResponse = await this.aiService.fetchFluxSync(fluxBody);

      if (!fluxResponse.ok) {
        const errText = await fluxResponse.text();
        console.error("Flux-AI sync error:", fluxResponse.status, errText);
        return res.status(fluxResponse.status).json({ error: "AI service error" });
      }

      const data = await fluxResponse.json();
      res.json(data);
    });

    this.uploadDocument = asyncHandler(async (req, res) => {
      const chatId = req.query.chatId || req.body?.chatId || "";
      const userId = req.user._id.toString();

      if (chatId) {
        const chat = await this.aiService.getChatById(chatId, userId);
        if (!chat) {
          return res.status(403).json({ error: "Forbidden: Chat not found or does not belong to you" });
        }
      }

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      let rawBody = Buffer.concat(chunks);

      if (rawBody.length === 0) {
        return res.status(400).json({ error: "Empty request body" });
      }

      const contentType = req.headers["content-type"] || "";
      rawBody = _injectMultipartFields(rawBody, contentType, {
        user_id: userId,
        chat_id: chatId,
      });

      const fluxResponse = await this.aiService.fetchDocumentUpload(rawBody, contentType);
      if (!fluxResponse.ok) {
        const errText = await fluxResponse.text();
        console.error("Flux-AI upload error:", fluxResponse.status, errText);
        return res.status(fluxResponse.status).json({ error: "Upload failed" });
      }

      const data = await fluxResponse.json();
      res.json(data);
    });

    this.getDocumentBulk = asyncHandler(async (req, res) => {
      const { ids } = req.query;
      if (!ids) return res.status(400).json({ error: "Missing ids parameter" });

      const fluxResponse = await this.aiService.fetchDocumentBulk(ids);
      if (!fluxResponse.ok) {
        return res.status(fluxResponse.status).json({ error: "Failed to fetch document metadata" });
      }
      res.json(await fluxResponse.json());
    });

    this.getDocument = asyncHandler(async (req, res) => {
      const { docId } = req.params;
      const fluxResponse = await this.aiService.fetchDocumentContent(docId);
      if (!fluxResponse.ok) {
        return res.status(fluxResponse.status).json({ error: "Document not found" });
      }
      res.json(await fluxResponse.json());
    });

    this.getDocuments = asyncHandler(async (req, res) => {
      const fluxResponse = await this.aiService.fetchDocumentsList();
      if (!fluxResponse.ok) {
        return res.status(fluxResponse.status).json({ error: "Failed to list documents" });
      }
      res.json(await fluxResponse.json());
    });

    this.health = asyncHandler(async (req, res) => {
      try {
        const fluxResponse = await this.aiService.fetchHealth();
        if (!fluxResponse.ok) {
          return res.status(503).json({ status: "unavailable" });
        }
        res.json(await fluxResponse.json());
      } catch (error) {
        res.status(503).json({ status: "unavailable", error: "Cannot reach AI service" });
      }
    });
  }
}
