import CycleModel from "../contexts/planning/cycle/cycle.schema.js";
import ProjectModel from "../contexts/organization/project/project.schema.js";
import WorkspaceModel from "../contexts/organization/workspace/workspace.schema.js";

export const checkCycleRole = (...requiredRoles) => {
  return async (req, res, next) => {
    try {
      const cycle = await CycleModel.findById(req.params.cycleId);
      if (!cycle) return res.status(404).json({ error: "Cycle not found" });

      const project = await ProjectModel.findById(cycle.project).populate("members.role");
      if (!project) return res.status(404).json({ error: "Project not found" });

      const workspace = await WorkspaceModel.findById(project.workspace).populate("members.role");
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const workspaceMember = workspace.members.find((m) => m.user.toString() === req.user._id.toString());
      if (workspaceMember?.role) {
        const wsRoleName = workspaceMember.role.name?.toLowerCase();
        if (["owner", "admin"].includes(wsRoleName)) {
          req.cycle = cycle;
          req.project = project;
          req.projectRole = "manager";
          return next();
        }
      }

      const projectMember = project.members.find((m) => m.user.toString() === req.user._id.toString());
      if (!projectMember) return res.status(403).json({ error: "Insufficient permissions" });

      const role = projectMember.role;
      if (!role?.name) return res.status(403).json({ error: "Role not found" });

      const roleName = role.name.toLowerCase();
      if (!requiredRoles.includes(roleName)) return res.status(403).json({ error: "Insufficient permissions" });

      req.cycle = cycle;
      req.project = project;
      req.projectRole = roleName;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};
