import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { checkTaskRole } from "../../../middleware/task.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateTaskDto, UpdateTaskDto, AssignTaskDto, ReorderTaskDto } from "./task.dto.js";

export const buildTaskRouter = (taskController) => {
  const taskRouter = Router();

  taskRouter.get("/workspace/:workspaceId/tasks", isAuthenticated, checkWorkspaceRole("member"), taskController.getWorkspaceTasks);
  taskRouter.get("/project/:projectId/tasks", isAuthenticated, checkProjectRole("manager", "member", "viewer"), taskController.getTasks);
  taskRouter.post("/project/:projectId/tasks", isAuthenticated, checkProjectRole("manager", "member"), validate(CreateTaskDto), taskController.createTask);
  
  // Project-context task routes (with checkTaskRole instead of checkProjectRole to properly populate req.task)
  taskRouter.get("/project/:projectId/tasks/:taskId", isAuthenticated, checkTaskRole("manager", "member", "viewer"), taskController.getTask);
  taskRouter.put("/project/:projectId/tasks/:taskId", isAuthenticated, checkTaskRole("manager", "member"), validate(UpdateTaskDto), taskController.updateTask);
  taskRouter.delete("/project/:projectId/tasks/:taskId", isAuthenticated, checkTaskRole("manager", "member"), taskController.deleteTask);
  taskRouter.put("/project/:projectId/tasks/:taskId/assign", isAuthenticated, checkTaskRole("manager", "member"), validate(AssignTaskDto), taskController.assignTask);
  taskRouter.post("/project/:projectId/tasks/:taskId/duplicate", isAuthenticated, checkTaskRole("manager", "member"), taskController.duplicateTask);
  taskRouter.put("/project/:projectId/tasks/reorder/batch", isAuthenticated, checkProjectRole("manager", "member"), validate(ReorderTaskDto), taskController.reorderTask);

  // Global-context task routes (alias paths mapped from frontend queries)
  taskRouter.get("/tasks/:taskId", isAuthenticated, checkTaskRole("manager", "member", "viewer"), taskController.getTask);
  taskRouter.put("/tasks/:taskId", isAuthenticated, checkTaskRole("manager", "member"), validate(UpdateTaskDto), taskController.updateTask);
  taskRouter.delete("/tasks/:taskId", isAuthenticated, checkTaskRole("manager", "member"), taskController.deleteTask);
  taskRouter.post("/tasks/:taskId/duplicate", isAuthenticated, checkTaskRole("manager", "member"), taskController.duplicateTask);

  return taskRouter;
}

