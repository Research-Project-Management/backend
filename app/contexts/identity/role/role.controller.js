import { AppError } from "../../../lib/AppError.js";
import { asyncHandler } from "../../../lib/asyncHandler.js";

export class RoleController {
  constructor({ roleService }) {
    this.roleService = roleService;
    this.getRoles = asyncHandler(async (req, res) => { res.json({ roles: await this.roleService.getRoles(req.params.workspaceId) }); });
    this.getRole = asyncHandler(async (req, res) => { const role = await this.roleService.getRole(req.params.roleId); if (!role) throw new AppError("Role not found", 404); res.json({ role }); });
    this.createRole = asyncHandler(async (req, res) => { res.status(201).json({ role: await this.roleService.createRole(req.params.workspaceId, req.body, req.user._id) }); });
    this.updateRole = asyncHandler(async (req, res) => { res.json({ role: await this.roleService.updateRole(req.params.roleId, req.body) }); });
    this.deleteRole = asyncHandler(async (req, res) => { await this.roleService.deleteRole(req.params.workspaceId, req.params.roleId); res.json({ message: "Role deleted successfully" }); });
    this.duplicateRole = asyncHandler(async (req, res) => { res.status(201).json({ role: await this.roleService.duplicateRole(req.params.workspaceId, req.params.roleId, req.user._id) }); });
  }
}



