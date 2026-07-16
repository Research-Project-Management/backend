import { AppError } from "../../../lib/AppError.js";
import { getIO } from "../../../config/socket.js";

export class PageCommentService {
  constructor({ pageCommentRepository}) {
    this.repo = pageCommentRepository;
    
  }

  _populate(query) { return query.populate("author", "name avatar").populate("replies.author", "name avatar"); }

  getComments(page) {
    const filter = page.parentPage ? { page: page._id } : { projectPageId: page._id };
    return this._populate(this.repo.find(filter));
  }

  async createComment(page, { content, line, lineEnd }, userId) {
    const projectPageId = page.parentPage ?? page._id;
    const comment = await this.repo.create({ page: page._id, projectPageId, author: userId, content, line: line ?? null, lineEnd: lineEnd ?? null });
    const populated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("page:" + page._id).emit("comment:created", { comment: populated, projectPageId: projectPageId.toString() });
    return populated;
  }

  async updateComment(commentId, pageId, { content, status }, userId) {
    const comment = await this.repo.findOne(commentId, pageId);
    if (!comment) throw new AppError("Comment not found", 404);
    if (content !== undefined) {
      if (comment.author.toString() !== userId.toString()) throw new AppError("Not the comment author", 403);
      comment.content = content;
    }
    if (status !== undefined) comment.status = status;
    await comment.save();
    const updated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("page:" + pageId).emit("comment:updated", { comment: updated });
    return updated;
  }

  async deleteComment(commentId, pageId, userId, project) {
    const comment = await this.repo.findOne(commentId, pageId);
    if (!comment) throw new AppError("Comment not found", 404);
    const isAuthor = comment.author.toString() === userId.toString();
    const isManager = project?.members?.find((m) => m.user.toString() === userId.toString())?.role?.name?.toLowerCase() === "manager";
    if (!isAuthor && !isManager) throw new AppError("Not allowed", 403);
    await comment.deleteOne();
    getIO()?.to("page:" + pageId).emit("comment:deleted", { commentId, pageId });
  }

  async addReply(commentId, pageId, { content }, userId) {
    const comment = await this.repo.findOne(commentId, pageId);
    if (!comment) throw new AppError("Comment not found", 404);
    comment.replies.push({ author: userId, content });
    await comment.save();
    const updated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("page:" + pageId).emit("reply:added", { comment: updated });
    return updated;
  }

  async deleteReply(commentId, pageId, replyId, userId) {
    const comment = await this.repo.findOne(commentId, pageId);
    if (!comment) throw new AppError("Comment not found", 404);
    const reply = comment.replies.id(replyId);
    if (!reply) throw new AppError("Reply not found", 404);
    if (reply.author.toString() !== userId.toString()) throw new AppError("Not the reply author", 403);
    reply.deleteOne();
    await comment.save();
    const updated = await this._populate(this.repo.findById(comment._id));
    getIO()?.to("page:" + pageId).emit("reply:removed", { comment: updated });
    return updated;
  }
}





