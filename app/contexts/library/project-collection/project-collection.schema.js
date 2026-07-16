import mongoose from "mongoose";

// ── ProjectCollection ─────────────────────────────────────────────────────────
// A named group of paper references inside a specific project.
// May optionally be linked to a workspace Library Collection (sourceCollection).

const projectCollectionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
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
        addedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        note: { type: String, default: "" },
        addedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

projectCollectionSchema.index({ project: 1, createdAt: -1 });
projectCollectionSchema.index({ workspace: 1, project: 1 });

const ProjectCollectionModel =
  mongoose.models.ProjectCollection ||
  mongoose.model("ProjectCollection", projectCollectionSchema);

export default ProjectCollectionModel;
