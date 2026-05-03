import mongoose from "mongoose";

/**
 * Tracks the last time each file was successfully synced to the LaTeX compiler.
 * Used by the incremental sync endpoint to skip files that haven't changed.
 */
const compilerSyncSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true }, // root page _id (string)
    fileId:    { type: String, required: true }, // child page _id or File._id
    fileType:  { type: String, enum: ["tex", "asset"], default: "tex" },
    syncedAt:  { type: Date, default: null },
  },
  { timestamps: false },
);

// Unique per (project, file) pair — upsert on every successful sync
compilerSyncSchema.index({ projectId: 1, fileId: 1 }, { unique: true });

const CompilerSync = mongoose.model("CompilerSync", compilerSyncSchema);

export default CompilerSync;
