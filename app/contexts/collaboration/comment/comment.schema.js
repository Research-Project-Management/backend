import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// --- Shared Reply Schema ---
export const replySchema = new mongoose.Schema(
  {
    authorId: { type: String, required: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// --- Base Comment Schema ---
const commentSchema = new mongoose.Schema(
  {
    authorId: { type: String, required: true, index: true },
    content: { type: String, required: true, trim: true, maxlength: 5000 },
    isEdited: { type: Boolean, default: false },
    replies: { type: [replySchema], default: [] },
  },
  { 
    timestamps: true,
    discriminatorKey: "kind", // 'PageComment' or 'TaskComment'
  }
);

const CommentModel = mongoose.models.Comment || mongoose.model("Comment", commentSchema);

// --- Page Comment Discriminator ---
const pageCommentSchema = new mongoose.Schema(
  {
    pageId: { type: String, required: true, index: true },
    projectPageId: { type: String, index: true },
    line: { type: Number, default: null },
    lineEnd: { type: Number, default: null },
    status: {
      type: String,
      enum: ["open", "resolved"],
      default: "open",
    },
  }
);

export const PageCommentModel =
  mongoose.models.PageComment ||
  CommentModel.discriminator("PageComment", pageCommentSchema);

// --- Task Comment Discriminator ---
const taskReactionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    emoji: { type: String, required: true, trim: true, maxlength: 8 },
  },
  { _id: false }
);

const taskCommentSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true, index: true },
    projectId: { type: String, required: true, index: true },
    reactions: { type: [taskReactionSchema], default: [] },
  }
);

taskCommentSchema.index({ taskId: 1, createdAt: -1 });
taskCommentSchema.index({ projectId: 1, taskId: 1, createdAt: -1 });

export const TaskCommentModel =
  mongoose.models.TaskComment ||
  CommentModel.discriminator("TaskComment", taskCommentSchema);

export default CommentModel;
