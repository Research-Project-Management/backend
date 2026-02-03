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
      required: true,
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

export default FileModel;
