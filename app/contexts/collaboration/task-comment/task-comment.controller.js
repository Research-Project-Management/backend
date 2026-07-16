import { asyncHandler } from "../../../lib/asyncHandler.js";

export class TaskCommentController {
  constructor({ taskCommentService }) {
    this.taskCommentService = taskCommentService;
    this.getCount = asyncHandler(async (req, res) => { res.json({ count: await this.taskCommentService.getCount(req.params.taskId) }); });
    this.getComments = asyncHandler(async (req, res) => { res.json({ comments: await this.taskCommentService.getComments(req.params.taskId, req.user._id, req.projectRole) }); });
    this.createComment = asyncHandler(async (req, res) => { res.status(201).json({ comment: await this.taskCommentService.createComment(req.task, req.project, req.body, req.user._id, req.projectRole) }); });
    this.updateComment = asyncHandler(async (req, res) => { res.json({ comment: await this.taskCommentService.updateComment(req.params.commentId, req.params.taskId, req.project, req.body, req.user._id, req.projectRole) }); });
    this.deleteComment = asyncHandler(async (req, res) => { await this.taskCommentService.deleteComment(req.params.commentId, req.params.taskId, req.project, req.user._id, req.projectRole); res.status(204).end(); });
    this.react = asyncHandler(async (req, res) => { res.json({ comment: await this.taskCommentService.react(req.params.commentId, req.params.taskId, req.project, req.body, req.user._id, req.projectRole) }); });
    this.addReply = asyncHandler(async (req, res) => { res.status(201).json({ comment: await this.taskCommentService.addReply(req.params.commentId, req.params.taskId, req.project, req.body, req.user._id, req.projectRole) }); });
    this.deleteReply = asyncHandler(async (req, res) => { res.json({ comment: await this.taskCommentService.deleteReply(req.params.commentId, req.params.taskId, req.params.replyId, req.project, req.user._id, req.projectRole) }); });
  }
}
