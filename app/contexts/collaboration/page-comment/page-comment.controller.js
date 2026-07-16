import { asyncHandler } from "../../../lib/asyncHandler.js";

export class PageCommentController {
  constructor({ pageCommentService }) {
    this.pageCommentService = pageCommentService;
    this.getComments = asyncHandler(async (req, res) => { res.json({ comments: await this.pageCommentService.getComments(req.page) }); });
    this.createComment = asyncHandler(async (req, res) => { res.status(201).json({ comment: await this.pageCommentService.createComment(req.page, req.body, req.user._id) }); });
    this.updateComment = asyncHandler(async (req, res) => { res.json({ comment: await this.pageCommentService.updateComment(req.params.commentId, req.params.pageId, req.body, req.user._id) }); });
    this.deleteComment = asyncHandler(async (req, res) => { await this.pageCommentService.deleteComment(req.params.commentId, req.params.pageId, req.user._id, req.project); res.status(204).end(); });
    this.addReply = asyncHandler(async (req, res) => { res.status(201).json({ comment: await this.pageCommentService.addReply(req.params.commentId, req.params.pageId, req.body, req.user._id) }); });
    this.deleteReply = asyncHandler(async (req, res) => { res.json({ comment: await this.pageCommentService.deleteReply(req.params.commentId, req.params.pageId, req.params.replyId, req.user._id) }); });
  }
}



