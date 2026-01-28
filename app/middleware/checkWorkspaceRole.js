import WorkspaceModel from "../schema/workspace.js";
import ProjectModel from "../schema/project.js";

// Kiểm tra quyền trong Workspace
export const checkWorkspaceRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      // Check if req.params.id is a MongoDB ObjectId or a URL
      let workspace;
      if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
        // It's a MongoDB ObjectId
        workspace = await WorkspaceModel.findById(req.params.id);
      } else {
        // It's a URL
        workspace = await WorkspaceModel.findOne({ url: req.params.id });
      }
      
      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      const member = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString()
      );

      if (!member) {
        return res
          .status(403)
          .json({ error: "Not a member of this workspace" });
      }

      if (!allowedRoles.includes(member.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.workspace = workspace;
      req.workspaceRole = member.role;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};

// Kiểm tra quyền trong Project
export const checkProjectRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const project = await ProjectModel.findById(req.params.projectId);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // Kiểm tra nếu user là admin/owner của workspace thì có full quyền
      const workspace = await WorkspaceModel.findById(project.workspace);
      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString()
      );

      if (
        workspaceMember &&
        ["owner", "admin"].includes(workspaceMember.role)
      ) {
        req.project = project;
        req.projectRole = "manager"; // workspace admin có quyền như manager
        return next();
      }

      // Kiểm tra quyền trong project
      const projectMember = project.members.find(
        (m) => m.user.toString() === req.user._id.toString()
      );

      if (!projectMember) {
        return res.status(403).json({ error: "Not a member of this project" });
      }

      if (!allowedRoles.includes(projectMember.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.project = project;
      req.projectRole = projectMember.role;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};

// Middleware xác thực đơn giản
export const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
};
