import { AppError } from "../../../lib/AppError.js";
import { getIO } from "../../../config/socket.js";

const REACTION_OPTIONS = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"];

export class TaskCommentService {
  constructor({ taskCommentRepository }) {
    this.repo = taskCommentRepository;
  }

  _populate(q) { return q.populate("author", "name avatar").populate("replies.author", "name avatar"); }

  _toResponse(comment, userId, projectRole) {
    const raw = comment.toObject ? comment.toObject() : comment;
    const currentUserId = userId.toString();
    const isManager = projectRole === "manager";
    const isAuthor = raw.author?._id?.toString?.() === currentUserId;
    const currentUserReaction = (raw.reactions || []).find((r) => r?.user?.toString?.() === currentUserId)?.emoji;
    return {
      ...raw,
      currentUserReaction,
      permissions: {
        canEdit: isAuthor,
        canDelete: isManager || isAuthor,
        canReply: projectRole === "manager" || projectRole === "member",
      },
      replies: (raw.replies || []).map((reply) => {
        const isReplyAuthor = reply.author?._id?.toString?.() === currentUserId;
        return {
          ...reply,
          permissions: {
            canDelete: isManager || isReplyAuthor,
          },
        };
      }),
    };
  }

  getCount(taskId) { return this.repo.count(taskId); }

  async getComments(taskId, userId, projectRole) {
    const comments = await this._populate(this.repo.find(taskId));
    return comments.map((c) => this._toResponse(c, userId, projectRole));
  }

  async createComment(task, project, { content }, userId, projectRole) {
    const comment = await this.repo.create({ task: task._id, project: project._id, author: userId, content });
    const populated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("project:" + project._id).emit("task-comment:created", { taskId: task._id, comment: this._toResponse(populated, userId, projectRole) });
    return this._toResponse(populated, userId, projectRole);
  }

  async updateComment(commentId, taskId, project, { content }, userId, projectRole) {
    const comment = await this.repo.findOne(commentId, taskId);
    if (!comment) throw new AppError("Comment not found", 404);
    if (comment.project.toString() !== project._id.toString()) throw new AppError("Insufficient permissions", 403);
    if (comment.author.toString() !== userId.toString()) throw new AppError("Not the comment author", 403);
    if (content !== undefined) {
      if (comment.content !== content) comment.isEdited = true;
      comment.content = content;
    }
    await comment.save();
    const populated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("project:" + project._id).emit("task-comment:updated", { taskId, comment: this._toResponse(populated, userId, projectRole) });
    return this._toResponse(populated, userId, projectRole);
  }

  async deleteComment(commentId, taskId, project, userId, projectRole) {
    const comment = await this.repo.findOne(commentId, taskId);
    if (!comment) throw new AppError("Comment not found", 404);
    const isAuthor = comment.author.toString() === userId.toString();
    if (!isAuthor && projectRole !== "manager") throw new AppError("Not allowed", 403);
    await comment.deleteOne();
    getIO()?.to("project:" + project._id).emit("task-comment:deleted", { taskId, commentId });
  }

  async react(commentId, taskId, project, { emoji }, userId, projectRole) {
    const normalizedEmoji = typeof emoji === "string" ? emoji.trim() : "";
    if (normalizedEmoji && !REACTION_OPTIONS.includes(normalizedEmoji)) throw new AppError("Invalid emoji", 400);
    const comment = await this.repo.findOne(commentId, taskId);
    if (!comment) throw new AppError("Comment not found", 404);
    comment.reactions = (comment.reactions || []).filter((r) => r.user.toString() !== userId.toString());
    if (normalizedEmoji) comment.reactions.push({ user: userId, emoji: normalizedEmoji });
    await comment.save();
    const populated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("project:" + project._id).emit("task-comment:updated", { taskId, comment: this._toResponse(populated, userId, projectRole) });
    return this._toResponse(populated, userId, projectRole);
  }

  async addReply(commentId, taskId, project, { content }, userId, projectRole) {
    const comment = await this.repo.findOne(commentId, taskId);
    if (!comment) throw new AppError("Comment not found", 404);
    comment.replies.push({ author: userId, content });
    await comment.save();
    const populated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("project:" + project._id).emit("task-reply:added", { taskId, comment: this._toResponse(populated, userId, projectRole) });
    return this._toResponse(populated, userId, projectRole);
  }

  async deleteReply(commentId, taskId, replyId, project, userId, projectRole) {
    const comment = await this.repo.findOne(commentId, taskId);
    if (!comment) throw new AppError("Comment not found", 404);
    const reply = comment.replies.id(replyId);
    if (!reply) throw new AppError("Reply not found", 404);
    if (reply.author.toString() !== userId.toString() && projectRole !== "manager") throw new AppError("Not allowed", 403);
    reply.deleteOne(); await comment.save();
    const populated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("project:" + project._id).emit("task-reply:removed", { taskId, comment: this._toResponse(populated, userId, projectRole) });
    return this._toResponse(populated, userId, projectRole);
  }
}
