import ProjectModel from "../contexts/organization/project/project.schema.js";
import UserModel from "../contexts/identity/auth/auth.schema.js";
import { getCachedWorkspace } from "./workspace.middleware.js";
import { getOrSetCache, deleteCache } from "../config/cache.js";
import { AppError } from "../lib/AppError.js";

const WORKSPACE_CACHE_TTL = 60;
const PROJECT_CACHE_TTL = 30;

export const clearProjectCache = async (projectId) => {
  await deleteCache(`proj:${projectId}`);
};

export const getCachedProject = async (projectId) => {
  if (!projectId) return null;
  return getOrSetCache(
    `proj:${projectId}`,
    async () => {
      const project = await ProjectModel.findById(projectId).lean();
      if (!project) return null;
      
      const userIds = project.members.map(m => m.userId).filter(Boolean);
      const users = await UserModel.find({ _id: { $in: userIds } }).select("name email avatar").lean();
      const userMap = new Map(users.map(u => [u._id.toString(), u]));
      
      project.members = project.members.map(m => ({
        ...m,
        user: userMap.get(m.userId?.toString()) || { _id: m.userId, name: "Unknown User", email: "", avatar: null }
      }));
      
      return project;
    },
    PROJECT_CACHE_TTL
  );
};

export const checkProjectRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const projectId = req.params.projectId;
      if (!projectId) throw new AppError("Project identifier missing", 400);

      const project = await getCachedProject(projectId);
      if (!project) throw new AppError("Project not found", 404);

      const workspace = await getCachedWorkspace(project.workspaceId);
      const workspaceMember = workspace?.members.find((m) => m.userId.toString() === req.user._id.toString());
      
      if (workspaceMember?.role && ["owner", "admin"].includes(workspaceMember.role.toLowerCase())) {
        req.project = project;
        req.projectRole = workspaceMember.role.toLowerCase();
        req.userRole = { name: workspaceMember.role.toLowerCase() };
        return next();
      }

      const projectMember = project.members.find((m) => m.userId.toString() === req.user._id.toString());
      if (!projectMember) throw new AppError("Not a member of this project", 403);

      const roleName = (projectMember.role || "member").toLowerCase();
      let effectiveAllowedRoles = [...allowedRoles];
      if (effectiveAllowedRoles.includes("viewer")) effectiveAllowedRoles.push("member", "admin", "owner");
      if (effectiveAllowedRoles.includes("member")) effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin")) effectiveAllowedRoles.push("owner");

      if (!effectiveAllowedRoles.some((r) => r.toLowerCase() === roleName)) {
        throw new AppError("Insufficient permissions", 403);
      }

      req.project = project;
      req.projectRole = roleName;
      req.userRole = { name: roleName };
      return next();
    } catch (error) {
      next(error);
    }
  };
};
