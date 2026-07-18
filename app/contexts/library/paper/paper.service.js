import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "../../../config/r2.js";

const extractR2KeyFromFileUrl = (fileUrl) => {
  if (!fileUrl || typeof fileUrl !== "string") return null;
  const trimmedUrl = fileUrl.trim();
  const match = trimmedUrl.match(/\/api\/files\/([^?#]+)/);
  if (match?.[1]) return decodeURIComponent(match[1]);
  if (!trimmedUrl.startsWith("http") && !trimmedUrl.startsWith("/") && !trimmedUrl.startsWith("r2://")) {
    return trimmedUrl;
  }
  if (trimmedUrl.startsWith("r2://")) {
    const withoutScheme = trimmedUrl.slice("r2://".length);
    const [, ...keyParts] = withoutScheme.split("/");
    return keyParts.join("/") || null;
  }
  return null;
};

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const fetchPaperFileBuffer = async (fileUrl) => {
  const r2Key = extractR2KeyFromFileUrl(fileUrl);
  if (r2Key) {
    const response = await r2.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: r2Key,
      }),
    );
    return streamToBuffer(response.Body);
  }
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PaperService {
  constructor({ paperRepository }) {
    this.paperRepository = paperRepository;
  }

  async indexPaperForRag(paperId, userId) {
    const paper = await this.paperRepository.findById(paperId);
    if (!paper) return null;

    await this.paperRepository.incrementRagAttempts(paperId);

    const fileBuffer = await fetchPaperFileBuffer(paper.fileUrl);
    const form = new FormData();
    form.append(
      "file",
      new Blob([fileBuffer], { type: paper.mimeType || "application/pdf" }),
      paper.filename || "paper.pdf",
    );
    form.append("title", paper.title);
    form.append("user_id", userId.toString());

    const fluxAiUrl = process.env.FLUX_AI_URL || "http://localhost:8000";
    const uploadRes = await fetch(`${fluxAiUrl}/documents/upload`, {
      method: "POST",
      body: form,
    });

    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => "");
      throw new Error(`Flux-AI upload failed: ${uploadRes.status} ${body}`);
    }

    const uploadData = await uploadRes.json();
    const ragDocId = uploadData.id;
    if (!ragDocId) {
      throw new Error("Flux-AI upload did not return document id");
    }

    return this.paperRepository.updateRagStatus(paper._id, {
      ragDocId,
      ragIndexedAt: new Date(),
      ragStatus: "indexed",
      ragError: "",
    });
  }

  triggerPaperRagIndex(paperId, userId) {
    setImmediate(async () => {
      const maxAttempts = 3;
      let lastError = null;
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            await this.indexPaperForRag(paperId, userId);
            lastError = null;
            return;
          } catch (err) {
            lastError = err;
            console.error(
              `[Library] RAG index attempt ${attempt}/${maxAttempts} failed for paper`,
              paperId,
              err.message,
            );
            if (attempt < maxAttempts) {
              await sleep(attempt * 1500);
            }
          }
        }
      } finally {
        if (lastError) {
          await this.paperRepository.updateRagStatus(paperId, {
            ragStatus: "failed",
            ragLastAttemptAt: new Date(),
            ragError: lastError.stack || lastError.message || String(lastError),
          });
        }
      }
    });
  }

  async getPapers(workspaceId) {
    return this.paperRepository.findByWorkspace(workspaceId);
  }

  async getPapersByCollection(workspaceId, collectionId) {
    return this.paperRepository.findByCollection(workspaceId, collectionId);
  }


  async uploadPaper(workspaceId, userId, dto) {
    if (!dto.title || !dto.filename || !dto.fileUrl) {
      throw new Error("Missing required paper data");
    }

    const paper = await this.paperRepository.create({
      title: dto.title,
      authors: dto.authors,
      year: dto.year || null,
      filename: dto.filename,
      fileUrl: dto.fileUrl,
      size: dto.size,
      mimeType: dto.mimeType,
      workspaceId: workspaceId,
      collectionId: dto.collectionId || null,
      uploadedById: userId,
      ragStatus: "pending",
    });

    this.triggerPaperRagIndex(paper._id, userId);
    return paper;
  }

  async triggerReindex(workspaceId, userId, paperId) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new Error("Paper not found");

    this.triggerPaperRagIndex(paper._id, userId);
    return paper;
  }

  async updatePaper(workspaceId, paperId, dto) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new Error("Paper not found");

    for (const key of Object.keys(dto)) {
      paper[key] = dto[key];
    }
    await paper.save();
    return paper;
  }

  async deletePaper(workspaceId, paperId) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new Error("Paper not found");

    paper.deletedAt = new Date();
    await paper.save();
  }
}

