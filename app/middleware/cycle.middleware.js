import CycleModel from "../contexts/planning/cycle/cycle.schema.js";
import { getCachedProject } from "./project.middleware.js";
import { getCachedWorkspace } from "./workspace.middleware.js";
import { AppError } from "../lib/AppError.js";

export const checkCycleRole = (...requiredRoles) => {
  return async (req, res, next) => {
    try {
      const cycle = await CycleModel.findById(req.params.cycleId).lean();
      if (!cycle) throw new AppError("Cycle not found", 404);

      const project = await getCachedProject(cycle.projectId || cycle.project);
      if (!project) throw new AppError("Project not found", 404);

      const workspace = await getCachedWorkspace(project.workspaceId || project.workspace);
      if (!workspace) throw new AppError("Workspace not found", 404);

      const workspaceMember = workspace.members.find((m) => m.userId === req.user._id.toString());
      if (workspaceMember?.roleId) {
        const wsRoleName = workspaceMember.roleId.name?.toLowerCase();
        if (["owner", "admin"].includes(wsRoleName)) {
          req.cycle = cycle;
          req.project = project;
          req.projectRole = wsRoleName;
          return next();
        }
      }

      const projectMember = project.members.find((m) => m.userId === req.user._id.toString());
      if (!projectMember) throw new AppError("Insufficient permissions", 403);

      const role = projectMember.roleId;
      if (!role?.name) throw new AppError("Role not found", 403);

      const roleName = role.name.toLowerCase();
      if (!requiredRoles.includes(roleName)) throw new AppError("Insufficient permissions", 403);

      req.cycle = cycle;
      req.project = project;
      req.projectRole = roleName;
      next();
    } catch (error) {
      next(error);
    }
  };
};
