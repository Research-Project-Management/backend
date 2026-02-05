import WorkspaceModel from "../schema/workspace.js";
import ProjectModel from "../schema/project.js";

export const checkWorkspaceRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const inputId = req.params.id || req.params.workspaceId;

      if (!inputId) {
        return res.status(400).json({ error: "Workspace identifier missing" });
      }

      const isObjectId = inputId.match(/^[0-9a-fA-F]{24}$/);

      let workspace;
      if (isObjectId) {
        workspace = await WorkspaceModel.findById(inputId).populate({
          path: "members.role",
          model: "Role",
        });
      } else {
        workspace = await WorkspaceModel.findOne({ url: inputId }).populate({
          path: "members.role",
          model: "Role",
        });
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
      const project = await ProjectModel.findById(
        req.params.projectId,
      ).populate({
        path: "members.role",
        model: "Role",
      });
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // Kiểm tra nếu user là admin/owner của workspace thì có full quyền
      const workspace = await WorkspaceModel.findById(
        project.workspace,
      ).populate({
        path: "members.role",
        model: "Role",
      });
      const workspaceMember = workspace.members.find(
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

export const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
};
