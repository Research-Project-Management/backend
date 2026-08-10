// app/middleware/workspace.middleware.js
import WorkspaceModel from "../contexts/organization/workspace/workspace.schema.js";
import { getOrSetCache, deleteCache } from "../config/cache.js";
import { AppError } from "../lib/AppError.js";

const WORKSPACE_CACHE_TTL = 60;

export const clearWorkspaceCache = async (workspaceId) => {
  await deleteCache(`ws:${workspaceId}`);
};

export const getCachedWorkspace = async (inputId) => {
  if (!inputId) return null;
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(inputId);
  const cacheKey = `ws:${inputId}`;
  return getOrSetCache(
    cacheKey,
    async () => {
      if (isObjectId) {
        return await WorkspaceModel.findById(inputId).lean();
      } else {
        return await WorkspaceModel.findOne({ url: inputId }).lean();
      }
    },
    WORKSPACE_CACHE_TTL
  );
};

export const checkWorkspaceRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const inputId = req.params.id || req.params.workspaceId;
      if (!inputId) throw new AppError("Workspace identifier missing", 400);

      const workspace = await getCachedWorkspace(inputId);
      if (!workspace) throw new AppError("Workspace not found", 404);

      const member = workspace.members.find((m) => m.userId.toString() === req.user._id.toString());
      if (!member) throw new AppError("Not a member of this workspace", 403);

      const roleName = (member.role || "member").toLowerCase();
      let effectiveAllowedRoles = [...allowedRoles];
      if (effectiveAllowedRoles.includes("viewer")) effectiveAllowedRoles.push("member", "admin", "owner");
      if (effectiveAllowedRoles.includes("member")) effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin")) effectiveAllowedRoles.push("owner");

      if (!effectiveAllowedRoles.some((r) => r.toLowerCase() === roleName)) {
        throw new AppError("Insufficient permissions", 403);
      }

      req.workspace = workspace;
      req.workspaceRole = roleName;
      req.userRole = { name: roleName }; // Stub for backward compatibility
      next();
    } catch (error) {
      next(error);
    }
  };
};

// mapWorkspaceId — resolve URL slug → ObjectId, attach req.workspace
export const mapWorkspaceId = async (req, res, next) => {
  try {
    const inputId = req.params.workspaceId;
    if (!inputId) return next();
    const workspace = await getCachedWorkspace(inputId);
    if (!workspace) throw new AppError("Workspace not found", 404);
    req.workspace = workspace;
    next();
  } catch (error) {
    next(error);
  }
};
