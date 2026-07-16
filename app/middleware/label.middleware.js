import { LabelModel } from "../contexts/shared/label/label.schema.js";
import WorkspaceModel from "../contexts/organization/workspace/workspace.schema.js";

export const checkLabelRole = (...requiredRoles) => {
  return async (req, res, next) => {
    try {
      const label = await LabelModel.findById(req.params.labelId);
      if (!label) return res.status(404).json({ error: "Label not found" });

      const workspace = await WorkspaceModel.findById(label.workspace).populate("members.role");
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const workspaceMember = workspace.members.find((m) => m.user.toString() === req.user._id.toString());
      if (!workspaceMember) return res.status(403).json({ error: "Insufficient permissions" });

      const role = workspaceMember.role;
      if (!role?.name) return res.status(403).json({ error: "Role not found" });

      const roleName = role.name.toLowerCase();
      let effectiveAllowedRoles = [...requiredRoles];
      if (effectiveAllowedRoles.includes("member")) effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin")) effectiveAllowedRoles.push("owner");

      if (!effectiveAllowedRoles.some((r) => r.toLowerCase() === roleName)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.label = label;
      req.workspace = workspace;
      req.workspaceRole = roleName;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};
