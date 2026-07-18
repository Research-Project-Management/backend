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
    authorId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'User',
      required: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Workspace',
      required: true,
    },
    // Generic polymorphic owner instead of project & pageId
    linkedTo: {
      entityType: {
        type: String,
        enum: ["Project", "Page", "Task", "Comment", "Collection", "Workspace", "User", null],
        required: false,
        default: null
      },
      entityId: {
        type: String,
        required: false,
        default: null
      }
    },
    starred: { type: Boolean, default: false },
    trashedAt: { type: Date, default: null },
    sharedWith: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

fileSchema.virtual('author', {
  ref: 'User',
  localField: 'authorId',
  foreignField: '_id',
  justOne: true
});

fileSchema.virtual('sharedUsers', {
  ref: 'User',
  localField: 'sharedWith.userId',
  foreignField: '_id'
});

const FileModel = mongoose.models.File || mongoose.model("File", fileSchema);

// W7: Compound indexes for common storage query patterns.
if (!mongoose.models.File) {
  // Common multi-tenant index
  fileSchema.index({ workspaceId: 1, "linkedTo.entityId": 1, parent: 1, trashedAt: 1 });
  // Specific entity index
  fileSchema.index({ "linkedTo.entityId": 1, "linkedTo.entityType": 1, parent: 1, trashedAt: 1 });
  // My-files / starred / shared per author
  fileSchema.index({ workspaceId: 1, authorId: 1, trashedAt: 1 });
  fileSchema.index({ workspaceId: 1, starred: 1, trashedAt: 1 });
  // Dedup check in /upload
  fileSchema.index({ filename: 1, "linkedTo.entityId": 1, parent: 1, isFolder: 1 });
}

export default FileModel;
