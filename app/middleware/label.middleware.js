import { LabelModel } from "../contexts/shared/label/label.schema.js";
import { getCachedWorkspace } from "./workspace.middleware.js";
import { AppError } from "../lib/AppError.js";

export const checkLabelRole = (...requiredRoles) => {
  return async (req, res, next) => {
    try {
      const label = await LabelModel.findById(req.params.labelId).lean();
      if (!label) throw new AppError("Label not found", 404);

      const workspace = await getCachedWorkspace(label.workspaceId);
      if (!workspace) throw new AppError("Workspace not found", 404);

      const workspaceMember = workspace.members.find((m) => m.userId === req.user._id.toString());
      if (!workspaceMember) throw new AppError("Insufficient permissions", 403);

      const role = workspaceMember.roleId;
      if (!role?.name) throw new AppError("Role not found", 403);

      const roleName = role.name.toLowerCase();
      let effectiveAllowedRoles = [...requiredRoles];
      if (effectiveAllowedRoles.includes("member")) effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin")) effectiveAllowedRoles.push("owner");

      if (!effectiveAllowedRoles.some((r) => r.toLowerCase() === roleName)) {
        throw new AppError("Insufficient permissions", 403);
      }

      req.label = label;
      req.workspace = workspace;
      req.workspaceRole = roleName;
      next();
    } catch (error) {
      next(error);
    }
  };
};
