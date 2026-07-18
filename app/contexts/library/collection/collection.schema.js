import mongoose from "mongoose";

// ── Base Collection Schema ───────────────────────────────────────────────────
// Shared fields for all collection types
const collectionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Workspace',
      required: true,
    },
    createdById: {
      type: mongoose.Schema.Types.ObjectId, ref: 'User',
      required: true,
    },
  },
  { 
    timestamps: true,
    discriminatorKey: "kind", // 'WorkspaceCollection' or 'ProjectCollection'
  }
);

export const CollectionModel =
  mongoose.models.Collection || mongoose.model("Collection", collectionSchema);

// ── Workspace Collection Discriminator ────────────────────────────────────────
const workspaceCollectionSchema = new mongoose.Schema(
  {
    color: { type: String, default: "#3370ff" },
    icon: { type: String, default: "" },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collection",
      default: null,
    },
  }
);

workspaceCollectionSchema.index({ workspaceId: 1, parent: 1, createdAt: -1 });

export const WorkspaceCollectionModel =
  mongoose.models.WorkspaceCollection ||
  CollectionModel.discriminator("WorkspaceCollection", workspaceCollectionSchema);

// ── Project Collection Discriminator ──────────────────────────────────────────
const projectCollectionSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Project',
      required: true,
    },
    // If imported from a Library Collection, store the source ref
    sourceCollection: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collection",
      default: null,
    },
    // Array of paper references (lightweight — just IDs + meta)
    papers: [
      {
        paper: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Paper",
          required: true,
        },
        addedById: {
          type: mongoose.Schema.Types.ObjectId, ref: 'User',
        },
        note: { type: String, default: "" },
        addedAt: { type: Date, default: Date.now },
      },
    ],
  }
);

projectCollectionSchema.index({ projectId: 1, createdAt: -1 });
projectCollectionSchema.index({ workspaceId: 1, projectId: 1 });

export const ProjectCollectionModel =
  mongoose.models.ProjectCollection ||
  CollectionModel.discriminator("ProjectCollection", projectCollectionSchema);

export default CollectionModel;
