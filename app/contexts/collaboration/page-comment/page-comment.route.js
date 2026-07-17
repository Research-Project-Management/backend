import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkPageRole } from "../../../middleware/page.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreatePageCommentDto, UpdatePageCommentDto, AddPageReplyDto } from "./page-comment.dto.js";

export const buildCommentRouter = (pageCommentController) => {
  const commentRouter = Router();
  const m = [isAuthenticated, checkPageRole("manager", "member", "viewer")];
  const write = [isAuthenticated, checkPageRole("manager", "member")];

  commentRouter.get("/pages/:pageId/comments", m, pageCommentController.getComments);
  commentRouter.post("/pages/:pageId/comments", write, validate(CreatePageCommentDto), pageCommentController.createComment);
  commentRouter.put("/pages/:pageId/comments/:commentId", write, validate(UpdatePageCommentDto), pageCommentController.updateComment);
  commentRouter.delete("/pages/:pageId/comments/:commentId", write, pageCommentController.deleteComment);
  commentRouter.post("/pages/:pageId/comments/:commentId/replies", write, validate(AddPageReplyDto), pageCommentController.addReply);
  commentRouter.delete("/pages/:pageId/comments/:commentId/replies/:replyId", write, pageCommentController.deleteReply);

  return commentRouter;
}
