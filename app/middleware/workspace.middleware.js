// app/middleware/workspace.middleware.js
import WorkspaceModel from "../contexts/organization/workspace/workspace.schema.js";
import { getOrSetCache, deleteCache } from "../config/cache.js";

const WORKSPACE_CACHE_TTL = 60;

export const clearWorkspaceCache = async (workspaceId) => {
  await deleteCache(`ws:${workspaceId}`);
};

export const checkWorkspaceRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const inputId = req.params.id || req.params.workspaceId;
      if (!inputId) return res.status(400).json({ error: "Workspace identifier missing" });

      const isObjectId = inputId.match(/^[0-9a-fA-F]{24}$/);
      const cacheKey = `ws:${inputId}`;
      const workspace = await getOrSetCache(
        cacheKey,
        async () => {
          if (isObjectId) {
            return await WorkspaceModel.findById(inputId).populate({ path: "members.role", model: "Role" }).lean();
          } else {
            return await WorkspaceModel.findOne({ url: inputId }).populate({ path: "members.role", model: "Role" }).lean();
          }
        },
        WORKSPACE_CACHE_TTL
      );

      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const member = workspace.members.find((m) => m.user.toString() === req.user._id.toString());
      if (!member) return res.status(403).json({ error: "Not a member of this workspace" });

      const role = member.role;
      if (!role?.name) return res.status(403).json({ error: "Role not found" });

      const roleName = role.name.toLowerCase();
      let effectiveAllowedRoles = [...allowedRoles];
      if (effectiveAllowedRoles.includes("member")) effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin")) effectiveAllowedRoles.push("owner");

      if (!effectiveAllowedRoles.some((r) => r.toLowerCase() === roleName)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.workspace = workspace;
      req.workspaceRole = roleName;
      req.userRole = role;
      if (role.permissions) req.userPermissions = role.permissions;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};

// mapWorkspaceId — resolve URL slug → ObjectId, attach req.workspace
export const mapWorkspaceId = async (req, res, next) => {
  try {
    const inputId = req.params.workspaceId;
    if (!inputId) return next();
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(inputId);
    const cacheKey = `ws:${inputId}`;
    const workspace = await getOrSetCache(
      cacheKey,
      async () => {
        if (isObjectId) {
          return await WorkspaceModel.findById(inputId).populate({ path: "members.role", model: "Role" }).lean();
        } else {
          return await WorkspaceModel.findOne({ url: inputId }).populate({ path: "members.role", model: "Role" }).lean();
        }
      },
      WORKSPACE_CACHE_TTL
    );
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    req.workspace = workspace;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
