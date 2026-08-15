import { AppError } from "../../../lib/AppError.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fields explicitly allowed for update — prevents overwriting ownership/system fields
const UPDATABLE_FIELDS = [
  "title", "authors", "year", "doi", "abstract", "keywords", "itemType",
  "editors", "journal", "publicationTitle", "publicationDate", "publisher",
  "place", "labels", "volume", "issue", "section", "partNumber", "partTitle",
  "pages", "series", "seriesTitle", "seriesText", "issn", "isbn", "pmid",
  "pmcid", "url", "type", "language", "journalAbbr", "shortTitle", "rights",
  "license", "citationKey", "libraryCatalog", "archive", "archiveLocation",
  "callNumber", "accessedAt", "extra", "notes", "primaryFile", "collectionId",
];

function generateCitationKey(title, authors = [], year = null) {
  let firstAuthor = "author";
  if (authors && authors.length > 0 && typeof authors[0] === "string") {
    const name = authors[0].trim();
    const parts = name.split(/[\s,]+/);
    firstAuthor = parts[0].toLowerCase().replace(/[^a-z0-9]/g, "") || "author";
  }
  const cleanYear = year ? String(year) : new Date().getFullYear().toString();
  const cleanTitleWord = (title || "paper")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .find((w) => w.length > 3) || "doc";

  return `${firstAuthor}${cleanYear}${cleanTitleWord}`;
}

export class PaperService {
  constructor({ paperRepository, fileRepository, fileBufferService, crossrefClient }) {
    this.paperRepository = paperRepository;
    this.fileRepository = fileRepository;
    this.fileBufferService = fileBufferService;
    this.crossrefClient = crossrefClient;
  }

  // ── RAG Indexing (Resilient Background Worker) ────────────────────────────

  async indexPaperForRag(paperId, userId) {
    const paper = await this.paperRepository.findById(paperId);
    if (!paper) return null;

    await this.paperRepository.incrementRagAttempts(paperId);

    const fileUrl = paper.primaryFile?.url || paper.fileUrl;
    if (!fileUrl) return null;

    const fileBuffer = await this.fileBufferService.fetchBuffer(fileUrl);

    const form = new FormData();
    form.append(
      "file",
      new Blob([fileBuffer], {
        type: paper.primaryFile?.mimeType || paper.mimeType || "application/pdf",
      }),
      paper.primaryFile?.filename || paper.filename || "paper.pdf",
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
      throw new AppError(`Flux-AI upload failed: ${uploadRes.status} ${body}`, 502);
    }

    const uploadData = await uploadRes.json();
    const ragDocId = uploadData.id;
    if (!ragDocId) {
      throw new AppError("Flux-AI upload did not return document id", 502);
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

  // ── Unified Academic Ingestion Seam ───────────────────────────────────────

  async ingestPaper(workspaceId, userId, dto) {
    let filename = dto.filename || "paper.pdf";
    let fileUrl = dto.fileUrl || "";
    let size = dto.size || 0;
    let mimeType = dto.mimeType || "application/pdf";
    let fileId = dto.fileId || null;
    let title = dto.title || "";
    let authors = dto.authors || [];
    let year = dto.year || null;
    let doi = dto.doi || "";

    // 1. Resolve source payload
    if (dto.source === "storage" || (!fileUrl && dto.fileId)) {
      if (!this.fileRepository) {
        throw new AppError("File repository not available for storage import", 500);
      }
      const storageFile = await this.fileRepository.findOneById(dto.fileId);
      if (!storageFile) {
        throw new AppError("Storage file not found", 404);
      }
      fileId = storageFile._id;
      filename = storageFile.filename;
      fileUrl = storageFile.url;
      size = storageFile.size || 0;
      mimeType = storageFile.mimeType || "application/pdf";
      if (!title) {
        title = filename.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
      }
    }

    if (!fileUrl) {
      throw new AppError("A valid file URL or storage fileId is required", 400);
    }
    if (!title) {
      title = filename.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
    }

    // 2. Auto-enrich metadata from DOI if available
    let enrichedData = {};
    if (doi && this.crossrefClient) {
      try {
        const crossrefResult = await this.crossrefClient.getByDoi(doi);
        if (crossrefResult) {
          enrichedData = {
            title: crossrefResult.title || title,
            authors: crossrefResult.authors?.length ? crossrefResult.authors : authors,
            year: crossrefResult.year || year,
            journal: crossrefResult.journal || "",
            publicationTitle: crossrefResult.journal || "",
            publisher: crossrefResult.publisher || "",
            volume: crossrefResult.volume || "",
            issue: crossrefResult.issue || "",
            abstract: crossrefResult.abstract || "",
            issn: crossrefResult.issn || "",
            url: crossrefResult.url || "",
          };
          title = enrichedData.title;
          authors = enrichedData.authors;
          year = enrichedData.year;
        }
      } catch (err) {
        console.warn(`[Library] CrossRef lookup for DOI ${doi} failed gracefully:`, err.message);
      }
    }

    // 3. Generate Citation Key if missing
    const citationKey = dto.citationKey || generateCitationKey(title, authors, year);

    // 4. Construct Primary File and Multi-attachments
    const primaryFileData = {
      fileId,
      filename,
      url: fileUrl,
      size,
      mimeType,
    };

    const paper = await this.paperRepository.create({
      title,
      authors,
      year,
      doi,
      citationKey,
      ...enrichedData,
      primaryFile: primaryFileData,
      attachments: [
        {
          fileId,
          filename,
          url: fileUrl,
          size,
          mimeType,
          attachmentType: "primary_pdf",
          uploadedAt: new Date(),
        },
      ],
      // Legacy compatibility fields
      filename,
      fileUrl,
      size,
      mimeType,
      workspaceId,
      collectionId: dto.collectionId || null,
      uploadedById: userId,
      ragStatus: "pending",
    });

    // 5. Trigger resilient background vector RAG index
    this.triggerPaperRagIndex(paper._id, userId);

    return paper;
  }

  // ── Backward-compatible Aliases ───────────────────────────────────────────

  async uploadPaper(workspaceId, userId, dto) {
    return this.ingestPaper(workspaceId, userId, { source: "upload", ...dto });
  }

  async importFromStorage(workspaceId, userId, dto) {
    return this.ingestPaper(workspaceId, userId, { source: "storage", ...dto });
  }

  // ── Query & Attachment Operations ─────────────────────────────────────────

  async getPapers(workspaceId) {
    return this.paperRepository.findByWorkspace(workspaceId);
  }

  async getPapersByCollection(workspaceId, collectionId) {
    return this.paperRepository.findByCollection(workspaceId, collectionId);
  }

  async getPaperById(workspaceId, paperId) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new AppError("Paper not found", 404);
    return paper;
  }

  async addAttachment(workspaceId, paperId, userId, dto) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new AppError("Paper not found", 404);

    const attachmentData = {
      fileId: dto.fileId || null,
      filename: dto.filename,
      url: dto.url,
      size: dto.size || 0,
      mimeType: dto.mimeType || "application/octet-stream",
      attachmentType: dto.attachmentType || "supplementary",
      uploadedAt: new Date(),
    };

    return this.paperRepository.addAttachment(paper._id, attachmentData);
  }

  async removeAttachment(workspaceId, paperId, attachmentId) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new AppError("Paper not found", 404);

    return this.paperRepository.removeAttachment(paper._id, attachmentId);
  }

  async triggerReindex(workspaceId, userId, paperId) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new AppError("Paper not found", 404);

    this.triggerPaperRagIndex(paper._id, userId);
    return paper;
  }

  async updatePaper(workspaceId, paperId, dto) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new AppError("Paper not found", 404);

    const updates = {};
    for (const key of UPDATABLE_FIELDS) {
      if (dto[key] !== undefined) {
        updates[key] = dto[key];
      }
    }

    return this.paperRepository.updateById(paper._id, updates);
  }

  async deletePaper(workspaceId, paperId) {
    const paper = await this.paperRepository.findById(paperId, workspaceId);
    if (!paper) throw new AppError("Paper not found", 404);

    await this.paperRepository.softDelete(paper._id);
  }
}
