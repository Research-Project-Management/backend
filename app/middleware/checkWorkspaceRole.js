import WorkspaceModel from "../schema/workspace.js";
import ProjectModel from "../schema/project.js";
import { redisClient } from "../config/redis.js";

// TTL (giây) cho workspace/project cache
const WORKSPACE_CACHE_TTL = 60; // 60 giây
const PROJECT_CACHE_TTL = 30;   // 30 giây

/** Xóa cache workspace khi có thay đổi */
export const clearWorkspaceCache = async (workspaceId) => {
  try {
    await redisClient.del(`ws:${workspaceId}`);
  } catch (_) {}
};

/** Xóa cache project khi có thay đổi */
export const clearProjectCache = async (projectId) => {
  try {
    await redisClient.del(`proj:${projectId}`);
  } catch (_) {}
};

export const checkWorkspaceRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const inputId = req.params.id || req.params.workspaceId;

      if (!inputId) {
        return res.status(400).json({ error: "Workspace identifier missing" });
      }

      const isObjectId = inputId.match(/^[0-9a-fA-F]{24}$/);

      // ─ Thử lấy từ Redis cache trước ─────────────────────
      let workspace;
      const cacheKey = `ws:${inputId}`;
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          workspace = JSON.parse(cached);
        }
      } catch (_) {} // nếu Redis lỗi, tiếp tục query DB

      if (!workspace) {
        if (isObjectId) {
          workspace = await WorkspaceModel.findById(inputId)
            .populate({ path: "members.role", model: "Role" })
            .lean();
        } else {
          workspace = await WorkspaceModel.findOne({ url: inputId })
            .populate({ path: "members.role", model: "Role" })
            .lean();
        }
        // Lưu vào cache
        if (workspace) {
          try {
            await redisClient.setEx(cacheKey, WORKSPACE_CACHE_TTL, JSON.stringify(workspace));
          } catch (_) {}
        }
      }

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      const member = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (!member) {
        return res
          .status(403)
          .json({ error: "Not a member of this workspace" });
      }

      // Get role name from populated role object
      const role = member.role;
      if (!role || !role.name) {
        return res.status(403).json({ error: "Role not found" });
      }

      const roleName = role.name.toLowerCase();

      let effectiveAllowedRoles = [...allowedRoles];
      if (effectiveAllowedRoles.includes("member"))
        effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin"))
        effectiveAllowedRoles.push("owner");

      // Check using role name (case insensitive)
      const hasAccess = effectiveAllowedRoles.some(
        (allowed) => allowed.toLowerCase() === roleName,
      );

      if (!hasAccess) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.workspace = workspace;
      req.workspaceRole = roleName;
      req.userRole = role;
      if (role.permissions) {
        req.userPermissions = role.permissions;
      }
      next();
    } catch (error) {
      console.error(`[checkWorkspaceRole] Exception:`, error);
      res.status(500).json({ error: error.message });
    }
  };
};

// Kiểm tra quyền trong Project
export const checkProjectRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const projectId = req.params.projectId;

      // ─ Thử lấy project từ cache ──────────────────────
      let project;
      const projCacheKey = `proj:${projectId}`;
      try {
        const cached = await redisClient.get(projCacheKey);
        if (cached) {
          project = JSON.parse(cached);
        }
      } catch (_) {}

      if (!project) {
        project = await ProjectModel.findById(projectId)
          .populate({ path: "members.role", model: "Role" })
          .lean();
        if (project) {
          try {
            await redisClient.setEx(projCacheKey, PROJECT_CACHE_TTL, JSON.stringify(project));
          } catch (_) {}
        }
      }

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // Kiểm tra nếu user là admin/owner của workspace thì có full quyền
      const wsCacheKey = `ws:${project.workspace}`;
      let workspace;
      try {
        const cached = await redisClient.get(wsCacheKey);
        if (cached) workspace = JSON.parse(cached);
      } catch (_) {}

      if (!workspace) {
        workspace = await WorkspaceModel.findById(project.workspace)
          .populate({ path: "members.role", model: "Role" })
          .lean();
        if (workspace) {
          try {
            await redisClient.setEx(wsCacheKey, WORKSPACE_CACHE_TTL, JSON.stringify(workspace));
          } catch (_) {}
        }
      }

      const workspaceMember = workspace?.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (workspaceMember) {
        const role = workspaceMember.role;
        if (!role || !role.name) {
          return res.status(403).json({ error: "Workspace role not found" });
        }

        const roleName = role.name.toLowerCase();

        if (["owner", "admin"].includes(roleName)) {
          req.project = project;
          req.projectRole = "manager";
          req.userRole = role;
          if (role.permissions) {
            req.userPermissions = role.permissions;
          }
          return next();
        }
      }

      const projectMember = project.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (!projectMember) {
        return res.status(403).json({ error: "Not a member of this project" });
      }

      const role = projectMember.role;
      if (!role || !role.name) {
        return res.status(403).json({ error: "Project role not found" });
      }

      const roleName = role.name.toLowerCase();

      const hasAccess = allowedRoles.some(
        (allowed) => allowed.toLowerCase() === roleName,
      );

      if (!hasAccess) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.project = project;
      req.projectRole = roleName;
      req.userRole = role;
      if (role.permissions) {
        req.userPermissions = role.permissions;
      }
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};

import UserModel from "../schema/user.js";

export const isAuthenticated = async (req, res, next) => {
  // ── Internal API auth — FLux-AI calling on behalf of a user ──
  const internalKey = req.headers["x-internal-key"];
  if (internalKey) {
    if (internalKey !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ error: "Invalid internal API key" });
    }

    const userId = req.headers["x-user-id"];
    if (!userId) {
      return res.status(400).json({ error: "Missing X-User-Id header" });
    }

    try {
      const user = await UserModel.findById(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Impersonate the user — downstream middleware sees req.user as normal
      req.user = user;
      req.isInternalRequest = true;
      return next();
    } catch (err) {
      console.error("[isAuthenticated] Internal auth error:", err);
      return res.status(500).json({ error: "Internal auth failed" });
    }
  }

  // ── Standard session auth ──
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
};
