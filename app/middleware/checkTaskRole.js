import TaskModel from "../schema/task.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";

export const checkTaskRole = (...requiredRoles) => {
  return async (req, res, next) => {
    try {
      const task = await TaskModel.findById(req.params.taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });

      const project = await ProjectModel.findById(task.project).populate(
        "members.role",
      );
      if (!project) return res.status(404).json({ error: "Project not found" });

      const workspace = await WorkspaceModel.findById(project.workspace).populate(
        "members.role",
      );
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (workspaceMember?.role) {
        const wsRoleName = workspaceMember.role.name?.toLowerCase();
        if (["owner", "admin"].includes(wsRoleName)) {
          req.task = task;
          req.project = project;
          req.projectRole = "manager";
          return next();
        }
      }

      const projectMember = project.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );
      if (!projectMember) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const role = projectMember.role;
      if (!role || !role.name) {
        return res.status(403).json({ error: "Role not found" });
      }

      const roleName = role.name.toLowerCase();
      if (!requiredRoles.includes(roleName)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.task = task;
      req.project = project;
      req.projectRole = roleName;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};