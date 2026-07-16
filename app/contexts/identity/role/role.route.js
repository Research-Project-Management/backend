// contexts/identity/role/role.route.js
import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateRoleDto, UpdateRoleDto } from "./role.dto.js";

export const buildRoleRouter = (roleController) => {
  const roleRouter = Router();

roleRouter.get("/:workspaceId", isAuthenticated, checkWorkspaceRole("member"), roleController.getRoles);
roleRouter.get("/:workspaceId/:roleId", isAuthenticated, checkWorkspaceRole("member"), roleController.getRole);
roleRouter.post("/:workspaceId", isAuthenticated, checkWorkspaceRole("owner", "admin"), validate(CreateRoleDto), roleController.createRole);
roleRouter.put("/:workspaceId/:roleId", isAuthenticated, checkWorkspaceRole("owner", "admin"), validate(UpdateRoleDto), roleController.updateRole);
roleRouter.delete("/:workspaceId/:roleId", isAuthenticated, checkWorkspaceRole("owner", "admin"), roleController.deleteRole);
roleRouter.post("/:workspaceId/:roleId/duplicate", isAuthenticated, checkWorkspaceRole("owner", "admin"), roleController.duplicateRole);

  return roleRouter;
}



