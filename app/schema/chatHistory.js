import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    sources: { type: Array, default: [] },
  },
  { timestamps: true },
);

const chatHistorySchema = new mongoose.Schema(
  {
    workspace: {
      type: String, // stores the workspace URL slug (e.g. "my-workspace")
      required: true,
    },
    user: {
      type: String, // ObjectId string when authenticated, "dev-user" in dev
      required: true,
    },
    title: { type: String, default: "New Chat" },
    messages: [messageSchema],
    projectId: { type: String, default: null },
    documentIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Index for efficient querying by workspace slug + user, sorted by recently updated
chatHistorySchema.index({ workspace: 1, user: 1, updatedAt: -1 });

export default mongoose.model("ChatHistory", chatHistorySchema);
