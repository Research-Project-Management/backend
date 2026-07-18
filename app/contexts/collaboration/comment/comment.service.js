import { AppError } from "../../../lib/AppError.js";
import { eventBus, Events } from "../../../lib/eventBus.js";

// --- Base Comment Service ---
export class CommentService {
  constructor(repo) {
    this.repo = repo;
  }

  _populate(q) {
    return q;
  }

  // Abstract methods to be implemented by child classes
  _checkUpdatePermissions(comment, userId, options) { throw new Error("Not implemented"); }
  _checkDeletePermissions(comment, userId, options) { throw new Error("Not implemented"); }
  _checkDeleteReplyPermissions(reply, comment, userId, options) {
    if (reply.authorId !== userId.toString()) {
      throw new AppError("Not the reply author", 403);
    }
  }
  _updateExtraFields(comment, payload) {}
  _emitEvent(event, data, options) {}
  _formatResponse(comment, userId, options) { return comment; }

  async updateComment(commentId, parentId, payload, userId, options = {}) {
    const comment = await this.repo.findOne(commentId, parentId);
    if (!comment) throw new AppError("Comment not found", 404);
    
    this._checkUpdatePermissions(comment, userId, options);

    if (payload.content !== undefined) {
      if (comment.content !== payload.content) comment.isEdited = true;
      comment.content = payload.content;
    }
    this._updateExtraFields(comment, payload);
    
    await comment.save();
    const populated = await this._populate(this.repo.findById(comment._id));
    const response = this._formatResponse(populated, userId, options);
    
    this._emitEvent("updated", { parentId, response }, options);
    return response;
  }

  async deleteComment(commentId, parentId, userId, options = {}) {
    const comment = await this.repo.findOne(commentId, parentId);
    if (!comment) throw new AppError("Comment not found", 404);
    
    this._checkDeletePermissions(comment, userId, options);
    
    await comment.deleteOne();
    this._emitEvent("deleted", { commentId, parentId }, options);
  }

  async addReply(commentId, parentId, payload, userId, options = {}) {
    const comment = await this.repo.findOne(commentId, parentId);
    if (!comment) throw new AppError("Comment not found", 404);
    
    comment.replies.push({ authorId: userId, content: payload.content });
    await comment.save();
    
    const populated = await this._populate(this.repo.findById(comment._id));
    const response = this._formatResponse(populated, userId, options);
    
    this._emitEvent("replyAdded", { parentId, response }, options);
    return response;
  }

  async deleteReply(commentId, parentId, replyId, userId, options = {}) {
    const comment = await this.repo.findOne(commentId, parentId);
    if (!comment) throw new AppError("Comment not found", 404);
    
    const reply = comment.replies.id(replyId);
    if (!reply) throw new AppError("Reply not found", 404);
    
    this._checkDeleteReplyPermissions(reply, comment, userId, options);
    
    reply.deleteOne();
    await comment.save();
    
    const populated = await this._populate(this.repo.findById(comment._id));
    const response = this._formatResponse(populated, userId, options);
    
    this._emitEvent("replyDeleted", { parentId, response }, options);
    return response;
  }
}

// --- Page Comment Service ---
export class PageCommentService extends CommentService {
  constructor({ pageCommentRepository }) {
    super(pageCommentRepository);
  }

  getComments(page) {
    const filter = page.parentPage ? { pageId: page._id.toString() } : { projectPageId: page._id.toString() };
    return this._populate(this.repo.find(filter));
  }

  async createComment(page, { content, line, lineEnd }, userId) {
    const projectPageId = page.parentPage ?? page._id;
    const comment = await this.repo.create({ 
      pageId: page._id.toString(), 
      projectPageId: projectPageId.toString(), 
      authorId: userId, 
      content, 
      line: line ?? null, 
      lineEnd: lineEnd ?? null 
    });
    const populated = await this._populate(this.repo.findById(comment._id));
    eventBus.emit(Events.PAGE_COMMENT_CREATED, { pageId: page._id.toString(), payload: { comment: populated, projectPageId: projectPageId.toString() } });
    return populated;
  }

  _checkUpdatePermissions(comment, userId, options) {
    if (comment.authorId !== userId.toString()) {
      throw new AppError("Not the comment author", 403);
    }
  }

  _checkDeletePermissions(comment, userId, options) {
    const isAuthor = comment.authorId === userId.toString();
    const isManager = options.project?.members?.find((m) => m.user.toString() === userId.toString())?.role?.name?.toLowerCase() === "owner" || options.projectRole?.toLowerCase() === "admin";
    if (!isAuthor && !isManager) throw new AppError("Not allowed", 403);
  }

  _updateExtraFields(comment, payload) {
    if (payload.status !== undefined) comment.status = payload.status;
  }

  _emitEvent(event, data, options) {
    const pageId = data.parentId;
    if (event === "updated") eventBus.emit(Events.PAGE_COMMENT_UPDATED, { pageId: pageId.toString(), payload: { comment: data.response } });
    if (event === "deleted") eventBus.emit(Events.PAGE_COMMENT_DELETED, { pageId: pageId.toString(), payload: { commentId: data.commentId, pageId } });
    if (event === "replyAdded") eventBus.emit(Events.PAGE_REPLY_ADDED, { pageId: pageId.toString(), payload: { comment: data.response } });
    if (event === "replyDeleted") eventBus.emit(Events.PAGE_REPLY_REMOVED, { pageId: pageId.toString(), payload: { comment: data.response } });
  }
}

// --- Task Comment Service ---
const REACTION_OPTIONS = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"];

export class TaskCommentService extends CommentService {
  constructor({ taskCommentRepository }) {
    super(taskCommentRepository);
  }

  _toResponse(comment, userId, projectRole) {
    const raw = comment.toObject ? comment.toObject() : comment;
    const currentUserId = userId.toString();
    const isManager = ["owner", "admin"].includes(projectRole);
    const isAuthor = raw.authorId === currentUserId;
    const currentUserReaction = (raw.reactions || []).find((r) => r?.userId === currentUserId)?.emoji;
    return {
      ...raw,
      currentUserReaction,
      permissions: {
        canEdit: isAuthor,
        canDelete: isManager || isAuthor,
        canReply: ["owner", "admin"].includes(projectRole) || projectRole === "member",
      },
      replies: (raw.replies || []).map((reply) => {
        const isReplyAuthor = reply.authorId === currentUserId;
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
    const comment = await this.repo.create({ taskId: task._id.toString(), projectId: project._id.toString(), authorId: userId.toString(), content });
    const populated = await this._populate(this.repo.findById(comment._id));
    eventBus.emit(Events.TASK_COMMENT_CREATED, { projectId: project._id.toString(), payload: { taskId: task._id.toString(), comment: this._toResponse(populated, userId, projectRole) } });
    return this._toResponse(populated, userId, projectRole);
  }

  _checkUpdatePermissions(comment, userId, options) {
    if (comment.projectId !== options.project._id.toString()) throw new AppError("Insufficient permissions", 403);
    if (comment.authorId !== userId.toString()) throw new AppError("Not the comment author", 403);
  }

  _checkDeletePermissions(comment, userId, options) {
    const isAuthor = comment.authorId === userId.toString();
    if (!isAuthor && !["owner", "admin"].includes(options.projectRole)) throw new AppError("Not allowed", 403);
  }

  _checkDeleteReplyPermissions(reply, comment, userId, options) {
    if (reply.authorId !== userId.toString() && !["owner", "admin"].includes(options.projectRole)) {
      throw new AppError("Not allowed", 403);
    }
  }

  _formatResponse(comment, userId, options) {
    return this._toResponse(comment, userId, options.projectRole);
  }

  _emitEvent(event, data, options) {
    const taskId = data.parentId;
    const projectId = options.project._id;
    if (event === "updated") eventBus.emit(Events.TASK_COMMENT_UPDATED, { projectId: projectId.toString(), payload: { taskId, comment: data.response } });
    if (event === "deleted") eventBus.emit(Events.TASK_COMMENT_DELETED, { projectId: projectId.toString(), payload: { taskId, commentId: data.commentId } });
    if (event === "replyAdded") eventBus.emit(Events.TASK_REPLY_ADDED, { projectId: projectId.toString(), payload: { taskId, comment: data.response } });
    if (event === "replyDeleted") eventBus.emit(Events.TASK_REPLY_REMOVED, { projectId: projectId.toString(), payload: { taskId, comment: data.response } });
  }

  async react(commentId, taskId, project, { emoji }, userId, projectRole) {
    const normalizedEmoji = typeof emoji === "string" ? emoji.trim() : "";
    if (normalizedEmoji && !REACTION_OPTIONS.includes(normalizedEmoji)) throw new AppError("Invalid emoji", 400);
    const comment = await this.repo.findOne(commentId, taskId);
    if (!comment) throw new AppError("Comment not found", 404);
    comment.reactions = (comment.reactions || []).filter((r) => r.userId !== userId.toString());
    if (normalizedEmoji) comment.reactions.push({ userId: userId.toString(), emoji: normalizedEmoji });
    await comment.save();
    const populated = await this._populate(this.repo.findById(comment._id));
    const response = this._toResponse(populated, userId, projectRole);
    eventBus.emit(Events.TASK_COMMENT_UPDATED, { projectId: project._id.toString(), payload: { taskId: taskId.toString(), comment: response } });
    return response;
  }
}
