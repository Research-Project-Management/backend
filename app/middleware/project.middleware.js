// app/middleware/project.middleware.js
import ProjectModel from "../contexts/organization/project/project.schema.js";
import WorkspaceModel from "../contexts/organization/workspace/workspace.schema.js";
import { getOrSetCache, deleteCache } from "../config/cache.js";

const WORKSPACE_CACHE_TTL = 60;
const PROJECT_CACHE_TTL = 30;

export const clearProjectCache = async (projectId) => {
  await deleteCache(`proj:${projectId}`);
};

export const checkProjectRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const projectId = req.params.projectId;

      const project = await getOrSetCache(
        `proj:${projectId}`,
        async () => ProjectModel.findById(projectId).populate({ path: "members.role", model: "Role" }).lean(),
        PROJECT_CACHE_TTL
      );
      if (!project) return res.status(404).json({ error: "Project not found" });

      const workspace = await getOrSetCache(
        `ws:${project.workspace}`,
        async () => WorkspaceModel.findById(project.workspace).populate({ path: "members.role", model: "Role" }).lean(),
        WORKSPACE_CACHE_TTL
      );

      const workspaceMember = workspace?.members.find((m) => m.user.toString() === req.user._id.toString());
      if (workspaceMember?.role?.name && ["owner", "admin"].includes(workspaceMember.role.name.toLowerCase())) {
        req.project = project;
        req.projectRole = "manager";
        req.userRole = workspaceMember.role;
        if (workspaceMember.role.permissions) req.userPermissions = workspaceMember.role.permissions;
        return next();
      }

      const projectMember = project.members.find((m) => m.user.toString() === req.user._id.toString());
      if (!projectMember) return res.status(403).json({ error: "Not a member of this project" });

      const role = projectMember.role;
      if (!role?.name) return res.status(403).json({ error: "Project role not found" });

      const roleName = role.name.toLowerCase();
      let effectiveAllowedRoles = [...allowedRoles];
      if (effectiveAllowedRoles.includes("viewer")) effectiveAllowedRoles.push("member", "manager", "admin", "owner");
      if (effectiveAllowedRoles.includes("member")) effectiveAllowedRoles.push("manager", "admin", "owner");
      if (effectiveAllowedRoles.includes("manager")) effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin")) effectiveAllowedRoles.push("owner");

      if (!effectiveAllowedRoles.some((r) => r.toLowerCase() === roleName)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.project = project;
      req.projectRole = roleName;
      req.userRole = role;
      if (role.permissions) req.userPermissions = role.permissions;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};
