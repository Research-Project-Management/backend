import mongoose from "mongoose";

const projectSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: false,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: false,
    },
    uploadedAt: { type: Date, default: Date.now },
    size: { type: Number, required: true },
    mimeType: { type: String, required: true },
    url: { type: String, required: true },
  },
  {
    timestamps: true,
  }
);

const FileModel = mongoose.models.File || mongoose.model("File", projectSchema);

export default FileModel;
