import mongoose from "mongoose";

// ── Paper (individual uploaded paper/article in a collection) ─────────────────
// A Paper belongs to a workspace Library Collection or project collection.
// Files are stored in Cloudflare R2; we keep standard CSL metadata and attachments.

const paperSchema = new mongoose.Schema(
  {
    // Basic CSL metadata
    title: { type: String, required: true, trim: true },
    authors: [{ type: String, trim: true }],
    year: { type: Number, default: null },
    doi: { type: String, default: "", trim: true },
    abstract: { type: String, default: "" },
    keywords: [{ type: String }],
    itemType: { type: String, default: "journalArticle" },
    editors: [{ type: String, trim: true }],
    journal: { type: String, default: "" },
    publicationTitle: { type: String, default: "" },
    publicationDate: { type: String, default: "" },
    publisher: { type: String, default: "" },
    place: { type: String, default: "" },
    volume: { type: String, default: "" },
    issue: { type: String, default: "" },
    section: { type: String, default: "" },
    partNumber: { type: String, default: "" },
    partTitle: { type: String, default: "" },
    pages: { type: String, default: "" },
    series: { type: String, default: "" },
    seriesTitle: { type: String, default: "" },
    seriesText: { type: String, default: "" },
    issn: { type: String, default: "" },
    isbn: { type: String, default: "" },
    pmid: { type: String, default: "" },
    pmcid: { type: String, default: "" },
    url: { type: String, default: "" },
    type: { type: String, default: "" },
    language: { type: String, default: "" },
    journalAbbr: { type: String, default: "" },
    shortTitle: { type: String, default: "" },
    rights: { type: String, default: "" },
    license: { type: String, default: "" },
    citationKey: { type: String, default: "" },
    libraryCatalog: { type: String, default: "" },
    archive: { type: String, default: "" },
    archiveLocation: { type: String, default: "" },
    callNumber: { type: String, default: "" },
    accessedAt: { type: Date, default: null },
    extra: { type: String, default: "" },
    notes: [
      {
        content: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date, default: Date.now }
      }
    ],

    // Primary File (used for PDF Reader & Vector RAG)
    primaryFile: {
      fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
      url: { type: String, default: "" },
      filename: { type: String, default: "" },
      size: { type: Number, default: 0 },
      mimeType: { type: String, default: "application/pdf" },
    },

    // Attachments (Zotero Multi-Attachment Pattern: dataset, supplementary, slides, code)
    attachments: [
      {
        fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
        filename: { type: String, required: true },
        url: { type: String, required: true },
        size: { type: Number, default: 0 },
        mimeType: { type: String, default: "application/octet-stream" },
        attachmentType: {
          type: String,
          enum: ["primary_pdf", "supplementary", "dataset", "slides", "code", "figure", "other"],
          default: "supplementary",
        },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    // Legacy File fields (kept for 100% backward compatibility)
    fileUrl: { type: String, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, default: "application/pdf" },
    size: { type: Number, default: 0 },

    // Labels
    labels: [{ type: String }],

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
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Workspace',
      required: true,
    },
    uploadedById: {
      type: mongoose.Schema.Types.ObjectId, ref: 'User',
      required: true,
    },

    // Library collection (workspace-level) — null if unfiled
    collectionId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Collection',
      default: null,
    },

    // Soft-delete (for safe ref integrity)
    deletedAt: { type: Date, default: null },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  },
);

paperSchema.virtual('uploadedBy', {
  ref: 'User',
  localField: 'uploadedById',
  foreignField: '_id',
  justOne: true
});

paperSchema.virtual('collection', {
  ref: 'Collection',
  localField: 'collectionId',
  foreignField: '_id',
  justOne: true
});

paperSchema.index({ workspaceId: 1, collectionId: 1, deletedAt: 1, createdAt: -1 });
paperSchema.index({ workspaceId: 1, deletedAt: 1 });
paperSchema.index({ doi: 1 }); // for dedup by DOI

const PaperModel =
  mongoose.models.Paper || mongoose.model("Paper", paperSchema);

export default PaperModel;
