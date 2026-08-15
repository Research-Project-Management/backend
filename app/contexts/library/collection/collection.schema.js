import mongoose from "mongoose";

const collectionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    color: { type: String, default: "#3370ff" },
    icon: { type: String, default: "" },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collection",
      default: null,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    createdById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

collectionSchema.index({ workspaceId: 1, parent: 1, createdAt: -1 });

const CollectionModel =
  mongoose.models.Collection || mongoose.model("Collection", collectionSchema);

export default CollectionModel;
