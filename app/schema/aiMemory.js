import mongoose from "mongoose";

const aiMemorySchema = new mongoose.Schema(
  {
    user: {
      type: String,
      required: true,
      index: true,
    },
    workspace: {
      type: String,
      required: true,
      index: true,
    },
    projectId: {
      type: String,
      default: null,
      index: true,
    },
    scope: {
      type: String,
      enum: ["workspace", "project", "chat"],
      default: "workspace",
      index: true,
    },
    type: {
      type: String,
      enum: ["project_summary", "workspace_summary", "preference", "decision", "entity", "constraint"],
      required: true,
      index: true,
    },
    content: {
      type: String,
      required: true,
    },
    confidence: {
      type: Number,
      default: 0.7,
      min: 0,
      max: 1,
    },
    sourceChatId: {
      type: String,
      default: null,
      index: true,
    },
  },
  { timestamps: true },
);

aiMemorySchema.index({
  user: 1,
  workspace: 1,
  projectId: 1,
  scope: 1,
  type: 1,
  updatedAt: -1,
});

export default mongoose.model("AiMemory", aiMemorySchema);
