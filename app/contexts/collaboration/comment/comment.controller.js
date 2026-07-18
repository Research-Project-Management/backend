import { asyncHandler } from "../../../lib/asyncHandler.js";

export class CommentController {
  constructor(service) {
    this.service = service;

    this.updateComment = asyncHandler(async (req, res) => {
      const { parentId, options } = this._extractContext(req);
      const response = await this.service.updateComment(req.params.commentId, parentId, req.body, req.user._id, options);
      res.json({ comment: response });
    });

    this.deleteComment = asyncHandler(async (req, res) => {
      const { parentId, options } = this._extractContext(req);
      await this.service.deleteComment(req.params.commentId, parentId, req.user._id, options);
      res.status(204).end();
    });

    this.addReply = asyncHandler(async (req, res) => {
      const { parentId, options } = this._extractContext(req);
      const response = await this.service.addReply(req.params.commentId, parentId, req.body, req.user._id, options);
      res.status(201).json({ comment: response });
    });

    this.deleteReply = asyncHandler(async (req, res) => {
      const { parentId, options } = this._extractContext(req);
      const response = await this.service.deleteReply(req.params.commentId, parentId, req.params.replyId, req.user._id, options);
      res.json({ comment: response });
    });
  }

  // Abstract method to extract parentId and specific options from the Express request
  _extractContext(req) {
    throw new Error("Not implemented");
  }
}

// --- Page Comment Controller ---
export class PageCommentController extends CommentController {
  constructor({ pageCommentService }) {
    super(pageCommentService);

    this.getComments = asyncHandler(async (req, res) => {
      res.json({ comments: await this.service.getComments(req.page) });
    });

    this.createComment = asyncHandler(async (req, res) => {
      res.status(201).json({ comment: await this.service.createComment(req.page, req.body, req.user._id) });
    });
  }

  _extractContext(req) {
    return {
      parentId: req.params.pageId,
      options: { project: req.project, projectRole: req.projectRole }
    };
  }
}

// --- Task Comment Controller ---
export class TaskCommentController extends CommentController {
  constructor({ taskCommentService }) {
    super(taskCommentService);

    this.getCount = asyncHandler(async (req, res) => {
      res.json({ count: await this.service.getCount(req.params.taskId) });
    });
    this.getComments = asyncHandler(async (req, res) => {
      res.json({ comments: await this.service.getComments(req.params.taskId, req.user._id, req.projectRole) });
    });
    this.createComment = asyncHandler(async (req, res) => {
      res.status(201).json({ comment: await this.service.createComment(req.task, req.project, req.body, req.user._id, req.projectRole) });
    });
    this.react = asyncHandler(async (req, res) => {
      res.json({ comment: await this.service.react(req.params.commentId, req.params.taskId, req.project, req.body, req.user._id, req.projectRole) });
    });
  }

  _extractContext(req) {
    return {
      parentId: req.params.taskId,
      options: { project: req.project, projectRole: req.projectRole }
    };
  }
}
