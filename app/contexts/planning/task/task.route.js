import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { checkTaskRole } from "../../../middleware/task.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateTaskDto, UpdateTaskDto, AssignTaskDto, ReorderTaskDto, BulkUpdateTaskDto } from "./task.dto.js";

export const buildTaskRouter = (taskController) => {
  const taskRouter = Router();

  taskRouter.get("/workspace/:workspaceId/tasks", isAuthenticated, checkWorkspaceRole("owner", "admin", "member", "viewer"), taskController.getWorkspaceTasks);
  taskRouter.get("/project/:projectId/tasks", isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer"), taskController.getTasks);
  taskRouter.post("/project/:projectId/tasks", isAuthenticated, checkProjectRole("owner", "admin", "member"), validate(CreateTaskDto), taskController.createTask);
  taskRouter.put("/project/:projectId/tasks/reorder/batch", isAuthenticated, checkProjectRole("owner", "admin", "member"), validate(ReorderTaskDto), taskController.reorderTask);
  taskRouter.put("/project/:projectId/tasks/bulk", isAuthenticated, checkProjectRole("owner", "admin", "member"), validate(BulkUpdateTaskDto), taskController.bulkUpdateTasks);

  // Project-context task routes (with checkTaskRole instead of checkProjectRole to properly populate req.task)
  taskRouter.get("/project/:projectId/tasks/:taskId", isAuthenticated, checkTaskRole("owner", "admin", "member", "viewer"), taskController.getTask);
  taskRouter.put("/project/:projectId/tasks/:taskId", isAuthenticated, checkTaskRole("owner", "admin", "member"), validate(UpdateTaskDto), taskController.updateTask);
  taskRouter.delete("/project/:projectId/tasks/:taskId", isAuthenticated, checkTaskRole("owner", "admin", "member"), taskController.deleteTask);
  taskRouter.put("/project/:projectId/tasks/:taskId/assign", isAuthenticated, checkTaskRole("owner", "admin", "member"), validate(AssignTaskDto), taskController.assignTask);
  taskRouter.post("/project/:projectId/tasks/:taskId/duplicate", isAuthenticated, checkTaskRole("owner", "admin", "member"), taskController.duplicateTask);

  // Global-context task routes (alias paths mapped from frontend queries)
  taskRouter.get("/tasks/:taskId", isAuthenticated, checkTaskRole("owner", "admin", "member", "viewer"), taskController.getTask);
  taskRouter.get("/tasks/:taskId/activity", isAuthenticated, checkTaskRole("owner", "admin", "member", "viewer"), taskController.getAuditLog);
  taskRouter.put("/tasks/:taskId", isAuthenticated, checkTaskRole("owner", "admin", "member"), validate(UpdateTaskDto), taskController.updateTask);
  taskRouter.delete("/tasks/:taskId", isAuthenticated, checkTaskRole("owner", "admin", "member"), taskController.deleteTask);
  taskRouter.post("/tasks/:taskId/duplicate", isAuthenticated, checkTaskRole("owner", "admin", "member"), taskController.duplicateTask);

  return taskRouter;
}

