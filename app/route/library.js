import { Router } from "express";
import mongoose from "mongoose";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import CollectionModel from "../schema/collection.js";
import PaperModel from "../schema/paper.js";
import ProjectCollectionModel from "../schema/projectCollection.js";
import ProjectModel from "../schema/project.js";
import { r2 } from "../config/r2.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";
import { asyncHandler } from "../middleware/helpers.js";

const libraryRouter = Router();

const extractR2KeyFromFileUrl = (fileUrl) => {
  if (!fileUrl || typeof fileUrl !== "string") return null;

  const trimmedUrl = fileUrl.trim();
  const match = trimmedUrl.match(/\/api\/files\/([^?#]+)/);
  if (match?.[1]) return decodeURIComponent(match[1]);

  if (
    !trimmedUrl.startsWith("http") &&
    !trimmedUrl.startsWith("/") &&
    !trimmedUrl.startsWith("r2://")
  ) {
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

const indexPaperForRag = async (paperId, userId) => {
  const paper = await PaperModel.findById(paperId);
  if (!paper || paper.deletedAt) return null;

  await paper.updateOne({
    ragStatus: "pending",
    ragLastAttemptAt: new Date(),
    $inc: { ragAttempts: 1 },
    $unset: { ragError: "" },
  });

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

  return PaperModel.findByIdAndUpdate(
    paper._id,
    {
      ragDocId,
      ragIndexedAt: new Date(),
      ragStatus: "indexed",
      ragError: "",
    },
    { new: true },
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const triggerPaperRagIndex = (paperId, userId) => {
  setImmediate(async () => {
    const maxAttempts = 3;
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await indexPaperForRag(paperId, userId);
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
        await PaperModel.findByIdAndUpdate(paperId, {
          ragStatus: "failed",
          ragLastAttemptAt: new Date(),
          ragError: lastError.stack || lastError.message || String(lastError),
        });
      }
    }
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY COLLECTIONS (workspace-level)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/library/:workspaceId/collections
libraryRouter.get(
  "/:workspaceId/collections",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const collections = await CollectionModel.find({
      workspace: req.workspace._id,
    })
      .populate("createdBy", "name email avatar")
      .sort({ createdAt: -1 })
      .lean();

    // Attach paper count to each collection
    const counts = await PaperModel.aggregate([
      {
        $match: {
          workspace: req.workspace._id,
          deletedAt: null,
          collection: { $in: collections.map((c) => c._id) },
        },
      },
      { $group: { _id: "$collection", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));

    res.json({
      collections: collections.map((c) => ({
        ...c,
        paperCount: countMap.get(c._id.toString()) ?? 0,
      })),
    });
  }),
);

// POST /api/library/:workspaceId/collections
libraryRouter.post(
  "/:workspaceId/collections",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { name, description, color, icon } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: "Collection name is required" });
    }

    const collection = await CollectionModel.create({
      name: name.trim(),
      description: description || "",
      color: color || "#3370ff",
      icon: icon || "",
      workspace: req.workspace._id,
      createdBy: req.user._id,
    });

    const populated = await CollectionModel.findById(collection._id).populate(
      "createdBy",
      "name email avatar",
    );
    res.status(201).json({ collection: { ...populated.toObject(), paperCount: 0 } });
  }),
);

// PUT /api/library/:workspaceId/collections/:collectionId
libraryRouter.put(
  "/:workspaceId/collections/:collectionId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { name, description, color, icon } = req.body;
    const collection = await CollectionModel.findOne({
      _id: req.params.collectionId,
      workspace: req.workspace._id,
    });
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    if (name !== undefined) collection.name = name.trim();
    if (description !== undefined) collection.description = description;
    if (color !== undefined) collection.color = color;
    if (icon !== undefined) collection.icon = icon;
    await collection.save();

    res.json({ collection });
  }),
);

// DELETE /api/library/:workspaceId/collections/:collectionId
libraryRouter.delete(
  "/:workspaceId/collections/:collectionId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  asyncHandler(async (req, res) => {
    const collection = await CollectionModel.findOne({
      _id: req.params.collectionId,
      workspace: req.workspace._id,
    });
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    // Soft-delete all papers in this collection
    await PaperModel.updateMany(
      { collection: collection._id, deletedAt: null },
      { deletedAt: new Date() },
    );

    await CollectionModel.findByIdAndDelete(collection._id);
    res.status(204).end();
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// PAPERS inside a collection
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/library/:workspaceId/collections/:collectionId/papers
libraryRouter.get(
  "/:workspaceId/collections/:collectionId/papers",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const collection = await CollectionModel.findOne({
      _id: req.params.collectionId,
      workspace: req.workspace._id,
    });
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const papers = await PaperModel.find({
      collection: collection._id,
      deletedAt: null,
    })
      .populate("uploadedBy", "name email avatar")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ collection, papers });
  }),
);

// POST /api/library/:workspaceId/collections/:collectionId/papers
// Body: { title, authors?, year?, doi?, abstract?, keywords?, fileUrl, filename, mimeType, size, journal?, publisher?, tags? }
libraryRouter.post(
  "/:workspaceId/collections/:collectionId/papers",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const collection = await CollectionModel.findOne({
      _id: req.params.collectionId,
      workspace: req.workspace._id,
    });
    if (!collection) {
      return res.status(404).json({ error: "Collection not found" });
    }

    const {
      title,
      authors,
      year,
      doi,
      abstract,
      keywords,
      fileUrl,
      filename,
      mimeType,
      size,
      journal,
      publisher,
      tags,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: "Paper title is required" });
    }
    if (!fileUrl) {
      return res.status(400).json({ error: "fileUrl is required" });
    }

    const paper = await PaperModel.create({
      title: title.trim(),
      authors: Array.isArray(authors) ? authors : [],
      year: year ? Number(year) : null,
      doi: doi || "",
      abstract: abstract || "",
      keywords: Array.isArray(keywords) ? keywords : [],
      fileUrl,
      filename: filename || title,
      mimeType: mimeType || "application/pdf",
      size: size || 0,
      journal: journal || "",
      publisher: publisher || "",
      tags: Array.isArray(tags) ? tags : [],
      workspace: req.workspace._id,
      uploadedBy: req.user._id,
      collection: collection._id,
    });

    const populated = await PaperModel.findById(paper._id).populate(
      "uploadedBy",
      "name email avatar",
    );

    triggerPaperRagIndex(paper._id, req.user._id);

    res.status(201).json({ paper: populated });
  }),
);

// POST /api/library/:workspaceId/papers/:paperId/reindex
libraryRouter.post(
  "/:workspaceId/papers/:paperId/reindex",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const paper = await PaperModel.findOne({
      _id: req.params.paperId,
      workspace: req.workspace._id,
      deletedAt: null,
    });
    if (!paper) return res.status(404).json({ error: "Paper not found" });

    triggerPaperRagIndex(paper._id, req.user._id);
    res.json({ message: "Reindex triggered", paperId: paper._id });
  }),
);

// PUT /api/library/:workspaceId/papers/:paperId — update paper metadata
libraryRouter.put(
  "/:workspaceId/papers/:paperId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const paper = await PaperModel.findOne({
      _id: req.params.paperId,
      workspace: req.workspace._id,
      deletedAt: null,
    });
    if (!paper) return res.status(404).json({ error: "Paper not found" });

    const fields = [
      "title", "authors", "year", "doi", "abstract",
      "keywords", "journal", "publisher", "tags",
    ];
    for (const f of fields) {
      if (req.body[f] !== undefined) paper[f] = req.body[f];
    }
    await paper.save();
    res.json({ paper });
  }),
);

// DELETE /api/library/:workspaceId/papers/:paperId — soft delete
libraryRouter.delete(
  "/:workspaceId/papers/:paperId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const paper = await PaperModel.findOne({
      _id: req.params.paperId,
      workspace: req.workspace._id,
      deletedAt: null,
    });
    if (!paper) return res.status(404).json({ error: "Paper not found" });

    paper.deletedAt = new Date();
    await paper.save();
    res.status(204).end();
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT COLLECTIONS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/library/project/:projectId/collections
libraryRouter.get(
  "/project/:projectId/collections",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const projectCollections = await ProjectCollectionModel.find({
      project: req.project._id,
    })
      .populate("sourceCollection", "name color icon")
      .populate("createdBy", "name email avatar")
      .populate({
        path: "papers.paper",
        match: { deletedAt: null },
        select: "title authors year doi filename mimeType fileUrl size ragDocId ragStatus ragIndexedAt",
      })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ projectCollections });
  }),
);

// POST /api/library/project/:projectId/collections
libraryRouter.post(
  "/project/:projectId/collections",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { name, description } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: "Collection name is required" });
    }

    const pc = await ProjectCollectionModel.create({
      name: name.trim(),
      description: description || "",
      project: req.project._id,
      workspace: req.project.workspace,
      createdBy: req.user._id,
      papers: [],
    });

    res.status(201).json({ projectCollection: pc });
  }),
);

// POST /api/library/project/:projectId/collections/:pcId/import-library
// Import all papers from a workspace Library Collection into a project collection
libraryRouter.post(
  "/project/:projectId/collections/:pcId/import-library",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { collectionId } = req.body;
    if (!collectionId) {
      return res.status(400).json({ error: "collectionId is required" });
    }

    // Verify library collection belongs to same workspace
    const libCollection = await CollectionModel.findOne({
      _id: collectionId,
      workspace: req.project.workspace,
    });
    if (!libCollection) {
      return res.status(404).json({ error: "Library collection not found" });
    }

    const pc = await ProjectCollectionModel.findOne({
      _id: req.params.pcId,
      project: req.project._id,
    });
    if (!pc) {
      return res.status(404).json({ error: "Project collection not found" });
    }

    // Get all papers in the library collection
    const papers = await PaperModel.find({
      collection: libCollection._id,
      deletedAt: null,
    }).select("_id");

    // Only add papers not already in the project collection
    const existingIds = new Set(pc.papers.map((p) => p.paper.toString()));
    const toAdd = papers
      .filter((p) => !existingIds.has(p._id.toString()))
      .map((p) => ({
        paper: p._id,
        addedBy: req.user._id,
        note: "",
        addedAt: new Date(),
      }));

    if (toAdd.length > 0) {
      pc.papers.push(...toAdd);
      pc.sourceCollection = libCollection._id;
      await pc.save();
    }

    res.json({ added: toAdd.length, projectCollection: pc });
  }),
);

// POST /api/library/project/:projectId/collections/:pcId/papers
// Add a single paper reference to project collection
libraryRouter.post(
  "/project/:projectId/collections/:pcId/papers",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { paperId, note } = req.body;
    if (!paperId) {
      return res.status(400).json({ error: "paperId is required" });
    }

    // Verify paper belongs to same workspace
    const paper = await PaperModel.findOne({
      _id: paperId,
      workspace: req.project.workspace,
      deletedAt: null,
    });
    if (!paper) {
      return res.status(404).json({ error: "Paper not found" });
    }

    const pc = await ProjectCollectionModel.findOne({
      _id: req.params.pcId,
      project: req.project._id,
    });
    if (!pc) {
      return res.status(404).json({ error: "Project collection not found" });
    }

    const alreadyAdded = pc.papers.some(
      (p) => p.paper.toString() === paperId,
    );
    if (alreadyAdded) {
      return res.status(409).json({ error: "Paper already in this collection" });
    }

    pc.papers.push({
      paper: paper._id,
      addedBy: req.user._id,
      note: note || "",
      addedAt: new Date(),
    });
    await pc.save();

    res.status(201).json({ projectCollection: pc });
  }),
);

// DELETE /api/library/project/:projectId/collections/:pcId/papers/:paperId
libraryRouter.delete(
  "/project/:projectId/collections/:pcId/papers/:paperId",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const pc = await ProjectCollectionModel.findOne({
      _id: req.params.pcId,
      project: req.project._id,
    });
    if (!pc) return res.status(404).json({ error: "Project collection not found" });

    pc.papers = pc.papers.filter(
      (p) => p.paper.toString() !== req.params.paperId,
    );
    await pc.save();
    res.status(204).end();
  }),
);

// DELETE /api/library/project/:projectId/collections/:pcId
libraryRouter.delete(
  "/project/:projectId/collections/:pcId",
  isAuthenticated,
  checkProjectRole("manager"),
  asyncHandler(async (req, res) => {
    await ProjectCollectionModel.findOneAndDelete({
      _id: req.params.pcId,
      project: req.project._id,
    });
    res.status(204).end();
  }),
);

export default libraryRouter;
