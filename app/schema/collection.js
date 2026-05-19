import mongoose from "mongoose";

// ── Collection (workspace-level paper folder) ─────────────────────────────────

const collectionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    color: { type: String, default: "#3370ff" },
    icon: { type: String, default: "" },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Nested collections — null = root-level collection
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collection",
      default: null,
    },
  },
  { timestamps: true },
);

collectionSchema.index({ workspace: 1, parent: 1, createdAt: -1 });

const CollectionModel =
  mongoose.models.Collection ||
  mongoose.model("Collection", collectionSchema);

export default CollectionModel;
