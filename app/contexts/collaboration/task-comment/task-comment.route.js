import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkTaskRole } from "../../../middleware/task.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateTaskCommentDto, UpdateTaskCommentDto, AddTaskReplyDto, ReactTaskCommentDto } from "./task-comment.dto.js";

export const buildTaskCommentRouter = (taskCommentController) => {
  const commentRouter = Router();
  const m = [isAuthenticated, checkTaskRole("manager", "member", "viewer")];
  const write = [isAuthenticated, checkTaskRole("manager", "member")];

  commentRouter.get("/tasks/:taskId/comments/count", m, taskCommentController.getCount);
  commentRouter.get("/tasks/:taskId/comments", m, taskCommentController.getComments);
  commentRouter.post("/tasks/:taskId/comments", write, validate(CreateTaskCommentDto), taskCommentController.createComment);
  commentRouter.put("/tasks/:taskId/comments/:commentId", write, validate(UpdateTaskCommentDto), taskCommentController.updateComment);
  commentRouter.delete("/tasks/:taskId/comments/:commentId", write, taskCommentController.deleteComment);
  commentRouter.put("/tasks/:taskId/comments/:commentId/reaction", m, validate(ReactTaskCommentDto), taskCommentController.react);
  commentRouter.post("/tasks/:taskId/comments/:commentId/replies", write, validate(AddTaskReplyDto), taskCommentController.addReply);
  commentRouter.delete("/tasks/:taskId/comments/:commentId/replies/:replyId", write, taskCommentController.deleteReply);

  return commentRouter;
}
