import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    sources: { type: Array, default: [] },
    selectionContext: {
      type: {
        filename: { type: String, required: true },
        startLine: { type: Number, required: true },
        endLine: { type: Number, required: true },
        text: { type: String, required: true },
      },
      default: undefined,
    },
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
    summary: { type: String, default: "" },
    keyFacts: { type: [String], default: [] },
    openQuestions: { type: [String], default: [] },
    projectId: { type: String, default: null },
    documentIds: { type: [String], default: [] },
    // Per-page chat: when set, this chat is exclusively scoped to a LaTeX editor page
    pageId: { type: String, default: null },
  },
  { timestamps: true },
);

// Index for efficient querying by workspace slug + user, sorted by recently updated
chatHistorySchema.index({ workspace: 1, user: 1, updatedAt: -1 });
// Index for per-page lookup (LaTeX editor AI panel)
chatHistorySchema.index({ pageId: 1, user: 1 }, { sparse: true });

export default mongoose.model("ChatHistory", chatHistorySchema);
