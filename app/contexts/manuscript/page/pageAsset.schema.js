import mongoose from "mongoose";

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
export default PageAssetModel;
