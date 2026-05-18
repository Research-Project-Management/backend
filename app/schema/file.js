import mongoose from "mongoose";

const fileSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    isFolder: { type: Boolean, default: false },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "File",
      required: false,
      default: null,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: false,
      default: null,
    },
    // Link to a LaTeX page-project — set when asset is uploaded from the editor.
    pageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: false,
      default: null,
    },
    starred: { type: Boolean, default: false },
    trashedAt: { type: Date, default: null },
    sharedWith: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        permission: { type: String, enum: ["view", "edit"], default: "view" },
      },
    ],
    metaData: { type: Object, required: false },
    uploadedAt: { type: Date, default: Date.now },
    size: { type: Number, required: false }, // Not required for folders
    mimeType: { type: String, required: false }, // Not required for folders
    url: { type: String, required: false }, // Not required for folders
    thumbnail: { type: String, required: false }, // Thumbnail URL for images
  },
  {
    timestamps: true,
  }
);

const FileModel = mongoose.models.File || mongoose.model("File", fileSchema);

// W7: Compound indexes for common storage query patterns.
// All list/filter routes use (project/workspace + pageId + parent + trashedAt).
if (!mongoose.models.File) {
  // Project storage: /project/:id?parentId=&pageId=null&trashedAt=null
  fileSchema.index({ project: 1, pageId: 1, parent: 1, trashedAt: 1 });
  // Workspace storage: /workspace/:id + pageId filter
  fileSchema.index({ workspace: 1, pageId: 1, trashedAt: 1 });
  // Workspace all-files view (includes project cross-ref)
  fileSchema.index({ workspace: 1, project: 1, pageId: 1, parent: 1, trashedAt: 1 });
  // Editor assets: /page/:parentPageId
  fileSchema.index({ pageId: 1, parent: 1, trashedAt: 1 });
  // My-files / starred / shared per author
  fileSchema.index({ workspace: 1, author: 1, pageId: 1, trashedAt: 1 });
  fileSchema.index({ workspace: 1, starred: 1, pageId: 1, trashedAt: 1 });
  // Dedup check in /upload: (filename, pageId, parent)
  fileSchema.index({ filename: 1, pageId: 1, parent: 1, isFolder: 1 });
}

export default FileModel;
