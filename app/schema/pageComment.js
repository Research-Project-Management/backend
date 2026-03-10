import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const replySchema = new mongoose.Schema(
  {
    author: { type: ObjectId, ref: "User", required: true },
    content: { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: true },
);

const pageCommentSchema = new mongoose.Schema(
  {
    /** The file-level page this comment belongs to. */
    page: { type: ObjectId, ref: "Page", required: true, index: true },
    /** Root page-project — for listing all comments across a project. */
    projectPageId: { type: ObjectId, ref: "Page", index: true },
    author: { type: ObjectId, ref: "User", required: true },
    content: { type: String, required: true, maxlength: 5000 },
    /** Optional: start line number the comment was anchored to. */
    line: { type: Number, default: null },
    /** Optional: end line number for range comments. */
    lineEnd: { type: Number, default: null },
    status: {
      type: String,
      enum: ["open", "resolved"],
      default: "open",
    },
    replies: [replySchema],
  },
  { timestamps: true },
);

const PageCommentModel =
  mongoose.models.PageComment ||
  mongoose.model("PageComment", pageCommentSchema);

export default PageCommentModel;
