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
export default PageModel;
