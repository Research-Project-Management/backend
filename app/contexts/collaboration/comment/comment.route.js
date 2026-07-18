import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkPageRole } from "../../../middleware/page.middleware.js";
import { checkTaskRole } from "../../../middleware/task.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { 
  CreatePageCommentDto, UpdatePageCommentDto, AddPageReplyDto,
  CreateTaskCommentDto, UpdateTaskCommentDto, AddTaskReplyDto, ReactTaskCommentDto
} from "./comment.dto.js";

// --- Page Comment Routes ---
export const buildPageCommentRouter = (pageCommentController) => {
  const router = Router();
  const m = [isAuthenticated, checkPageRole("owner", "admin", "member", "viewer")];
  const write = [isAuthenticated, checkPageRole("owner", "admin", "member")];

  router.get("/pages/:pageId/comments", m, pageCommentController.getComments);
  router.post("/pages/:pageId/comments", write, validate(CreatePageCommentDto), pageCommentController.createComment);
  router.put("/pages/:pageId/comments/:commentId", write, validate(UpdatePageCommentDto), pageCommentController.updateComment);
  router.delete("/pages/:pageId/comments/:commentId", write, pageCommentController.deleteComment);
  router.post("/pages/:pageId/comments/:commentId/replies", write, validate(AddPageReplyDto), pageCommentController.addReply);
  router.delete("/pages/:pageId/comments/:commentId/replies/:replyId", write, pageCommentController.deleteReply);

  return router;
}

// --- Task Comment Routes ---
export const buildTaskCommentRouter = (taskCommentController) => {
  const router = Router();
  const m = [isAuthenticated, checkTaskRole("owner", "admin", "member", "viewer")];
  const write = [isAuthenticated, checkTaskRole("owner", "admin", "member")];

  router.get("/tasks/:taskId/comments/count", m, taskCommentController.getCount);
  router.get("/tasks/:taskId/comments", m, taskCommentController.getComments);
  router.post("/tasks/:taskId/comments", write, validate(CreateTaskCommentDto), taskCommentController.createComment);
  router.put("/tasks/:taskId/comments/:commentId", write, validate(UpdateTaskCommentDto), taskCommentController.updateComment);
  router.delete("/tasks/:taskId/comments/:commentId", write, taskCommentController.deleteComment);
  router.put("/tasks/:taskId/comments/:commentId/reaction", m, validate(ReactTaskCommentDto), taskCommentController.react);
  router.post("/tasks/:taskId/comments/:commentId/replies", write, validate(AddTaskReplyDto), taskCommentController.addReply);
  router.delete("/tasks/:taskId/comments/:commentId/replies/:replyId", write, taskCommentController.deleteReply);

  return router;
}
