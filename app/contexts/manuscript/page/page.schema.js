import mongoose from "mongoose";

const pageSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: mongoose.Schema.Types.Mixed, // Store JSON content from editor
      default: null,
    },
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    views: {
      type: Number,
      default: 0,
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now,
    },
    // Parent page — set for file-level pages that belong to a page-project container.
    // Top-level pages (shown in PagesManager) have parentPage: null.
    parentPage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      default: null,
    },
    // The file within this page-project that is used for compilation & as thumbnail.
    mainFile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      default: null,
    },
    // Base64 JPEG data URL of the first page of the last successful PDF build.
    pdfThumbnail: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

const PageModel = mongoose.models.Page || mongoose.model("Page", pageSchema);
export { PageModel };

// -- PageVersion Schema (co-located) --

const pageVersionSchema = new mongoose.Schema(
  {
    page: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: true,
      index: true,
    },
    /** Root page-project — allows querying all events for a project's timeline. */
    projectPageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      index: true,
    },
    // content is empty string for lifecycle events (file_created etc.)
    content: { type: String, default: "" },
    title: { type: String, default: "" },
    label: { type: String, default: "" },
    savedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    /**
     * manual_save  — user clicked "Save snapshot" in HistoryTab.
     * auto_save    — automatically recorded on content change (2-min sliding window).
     * file_created / file_deleted — a .tex child file was added/removed.
     * asset_uploaded / asset_deleted — a binary asset was added/removed.
     */
    eventType: {
      type: String,
      enum: [
        "manual_save",
        "auto_save",
        "file_created",
        "file_deleted",
        "asset_uploaded",
        "asset_deleted",
      ],
      default: "manual_save",
    },
    /** Name of the affected file (for display in the project timeline). */
    fileName: { type: String, default: "" },
  },
  { timestamps: true },
);

const PageVersionModel =
  mongoose.models.PageVersion ||
  mongoose.model("PageVersion", pageVersionSchema);
export { PageVersionModel };

// -- PageAsset Schema (co-located) --

const pageAssetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    mimeType: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    // Base64-encoded binary content stored directly in MongoDB.
    // Kept in a separate collection so the parent Page document stays small.
    data: { type: String, required: true },
    parentPage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

const PageAssetModel =
  mongoose.models.PageAsset || mongoose.model("PageAsset", pageAssetSchema);
export { PageAssetModel };
