// app/middleware/task.middleware.js
import { TaskModel } from "../contexts/planning/task/task.schema.js";
import { getCachedProject } from "./project.middleware.js";
import { getCachedWorkspace } from "./workspace.middleware.js";
import { AppError } from "../lib/AppError.js";

export const checkTaskRole = (...requiredRoles) => {
  return async (req, res, next) => {
    try {
      const task = await TaskModel.findById(req.params.taskId).lean();
      if (!task) throw new AppError("Task not found", 404);

      if (req.params.projectId && task.projectId.toString() !== req.params.projectId) {
        throw new AppError("Task does not belong to the specified project", 400);
      }

      const project = await getCachedProject(task.projectId);
      if (!project) throw new AppError("Project not found", 404);

      const workspace = await getCachedWorkspace(project.workspaceId);
      if (!workspace) throw new AppError("Workspace not found", 404);

      const workspaceMember = workspace.members.find((m) => m.userId === req.user._id.toString());
      if (workspaceMember?.roleId) {
        const wsRoleName = workspaceMember.roleId.name?.toLowerCase();
        if (["owner", "admin"].includes(wsRoleName)) {
          req.task = task;
          req.project = project;
          req.projectRole = wsRoleName;
          return next();
        }
      }

      const projectMember = project.members.find((m) => m.userId.toString() === req.user._id.toString());
      if (!projectMember) throw new AppError("Insufficient permissions", 403);

      const role = projectMember.roleId;
      if (!role?.name) throw new AppError("Role not found", 403);

      const roleName = role.name.toLowerCase();
      if (!requiredRoles.includes(roleName)) throw new AppError("Insufficient permissions", 403);

      req.task = task;
      req.project = project;
      req.projectRole = roleName;
      next();
    } catch (error) {
      next(error);
    }
  };
};
