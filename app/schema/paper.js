import mongoose from "mongoose";

// ── Paper (individual uploaded paper/article in a collection) ─────────────────
// A Paper can belong to a workspace Collection (Library) OR be directly
// attached to a Project Collection (projectCollection field set).
// Files are stored in Cloudflare R2; we only keep metadata here.

const paperSchema = new mongoose.Schema(
  {
    // Basic metadata
    title: { type: String, required: true, trim: true },
    authors: [{ type: String, trim: true }],
    year: { type: Number, default: null },
    doi: { type: String, default: "", trim: true },
    abstract: { type: String, default: "" },
    keywords: [{ type: String }],
    journal: { type: String, default: "" },
    publisher: { type: String, default: "" },

    // File
    fileUrl: { type: String, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, default: "application/pdf" },
    size: { type: Number, default: 0 },

    // Tags
    tags: [{ type: String }],

    // RAG indexing
    ragDocId: { type: String, default: null },
    ragIndexedAt: { type: Date, default: null },
    ragLastAttemptAt: { type: Date, default: null },
    ragAttempts: { type: Number, default: 0 },
    ragError: { type: String, default: "" },
    ragStatus: {
      type: String,
      enum: ["pending", "indexed", "failed", null],
      default: null,
    },

    // Ownership
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Library collection (workspace-level) — null if project-only paper
    collection: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collection",
      default: null,
    },

    // Soft-delete (for safe ref integrity)
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

paperSchema.index({ workspace: 1, collection: 1, deletedAt: 1, createdAt: -1 });
paperSchema.index({ workspace: 1, deletedAt: 1 });
paperSchema.index({ doi: 1 }); // for dedup by DOI

const PaperModel =
  mongoose.models.Paper || mongoose.model("Paper", paperSchema);

export default PaperModel;
