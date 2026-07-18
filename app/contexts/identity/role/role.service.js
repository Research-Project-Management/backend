import { AppError } from "../../../lib/AppError.js";

const DEFAULT_ROLES = (workspaceId, userId) => [
  { name: "Owner", description: "Full access to all workspace features and settings", type: "workspace", workspaceId: workspaceId, isDefault: true, isSystem: true, color: "#ef4444", permissions: [{ resource: "workspace", actions: ["create", "read", "update", "delete", "manage"] }, { resource: "project", actions: ["create", "read", "update", "delete", "manage"] }, { resource: "task", actions: ["create", "read", "update", "delete"] }, { resource: "page", actions: ["create", "read", "update", "delete"] }, { resource: "file", actions: ["create", "read", "update", "delete", "manage"] }, { resource: "sticky", actions: ["create", "read", "update", "delete"] }, { resource: "member", actions: ["create", "read", "update", "delete", "invite"] }, { resource: "settings", actions: ["read", "update", "manage"] }, { resource: "role", actions: ["create", "read", "update", "delete"] }], createdById: userId },
  { name: "Admin", description: "Can manage most workspace features except critical settings", type: "workspace", workspaceId: workspaceId, isDefault: true, isSystem: true, color: "#f59e0b", permissions: [{ resource: "workspace", actions: ["read", "update"] }, { resource: "project", actions: ["create", "read", "update", "delete"] }, { resource: "task", actions: ["create", "read", "update", "delete"] }, { resource: "page", actions: ["create", "read", "update", "delete"] }, { resource: "file", actions: ["create", "read", "update", "delete"] }, { resource: "sticky", actions: ["create", "read", "update", "delete"] }, { resource: "member", actions: ["read", "invite"] }, { resource: "settings", actions: ["read"] }, { resource: "role", actions: ["read"] }], createdById: userId },
  { name: "Member", description: "Standard member with basic access", type: "workspace", workspaceId: workspaceId, isDefault: true, isSystem: true, color: "#3b82f6", permissions: [{ resource: "workspace", actions: ["read"] }, { resource: "project", actions: ["read"] }, { resource: "task", actions: ["create", "read", "update"] }, { resource: "page", actions: ["create", "read", "update"] }, { resource: "file", actions: ["create", "read", "update"] }, { resource: "sticky", actions: ["create", "read", "update"] }, { resource: "member", actions: ["read"] }, { resource: "settings", actions: ["read"] }, { resource: "role", actions: ["read"] }], createdById: userId },
  { name: "Viewer", description: "Read-only access to projects", type: "workspace", workspaceId: workspaceId, isDefault: true, isSystem: true, color: "#9ca3af", permissions: [{ resource: "workspace", actions: ["read"] }, { resource: "project", actions: ["read"] }, { resource: "task", actions: ["read"] }, { resource: "page", actions: ["read"] }, { resource: "file", actions: ["read"] }, { resource: "sticky", actions: ["read"] }, { resource: "member", actions: ["read"] }], createdById: userId },
];

export class RoleService {
  constructor({ roleRepository, workspaceRepository }) {
    this.roleRepository = roleRepository;
    this.workspaceRepository = workspaceRepository;
  }

  async initializeDefaultRoles(workspaceId, userId) {
    const created = await this.roleRepository.insertMany(DEFAULT_ROLES(workspaceId, userId));
    return { owner: created[0]._id, admin: created[1]._id, member: created[2]._id };
  }

  getRoles(workspaceId) { return this.roleRepository.findByWorkspace(workspaceId); }
  getRole(roleId) { return this.roleRepository.findById(roleId); }
  getRoleByName(workspaceId, name) { return this.roleRepository.findByWorkspaceAndName(workspaceId, name); }

  async createRole(workspaceId, { name, description, permissions, color }, userId) {
    const existing = await this.roleRepository.findByWorkspaceAndName(workspaceId, name);
    if (existing) throw new AppError("Role name already exists", 400);
    const role = await this.roleRepository.create({ name, description, type: "workspace", workspaceId: workspaceId, permissions, color, isDefault: false, isSystem: false, createdById: userId });
    return role;
  }

  async updateRole(roleId, { name, description, permissions, color }) {
    const role = await this.roleRepository.findById(roleId);
    if (!role) throw new AppError("Role not found", 404);
    if (role.isSystem) throw new AppError("Cannot modify system roles", 403);
    if (name && name !== role.name) {
      const existing = await this.roleRepository.findByWorkspaceAndName(role.workspaceId, name, roleId);
      if (existing) throw new AppError("Role name already exists", 400);
    }
    if (name) role.name = name;
    if (description !== undefined) role.description = description;
    if (permissions) role.permissions = permissions;
    if (color) role.color = color;
    await role.save();
    return role;
  }

  async deleteRole(workspaceId, roleId) {
    const role = await this.roleRepository.findById(roleId);
    if (!role) throw new AppError("Role not found", 404);
    if (role.isSystem) throw new AppError("Cannot delete system roles", 403);
    const workspace = await this.workspaceRepository.findById(workspaceId);
    if (workspace?.members.some((m) => m.roleId === roleId)) throw new AppError("Cannot delete role that is currently assigned to members", 400);
    await this.roleRepository.deleteById(roleId);
  }

  async duplicateRole(workspaceId, roleId, userId) {
    const original = await this.roleRepository.findById(roleId);
    if (!original) throw new AppError("Role not found", 404);
    let newName = `${original.name} (Copy)`;
    let counter = 1;
    while (await this.roleRepository.findByWorkspaceAndName(workspaceId, newName)) { counter++; newName = `${original.name} (Copy ${counter})`; }
    const duplicated = await this.roleRepository.create({ name: newName, description: original.description, type: original.type, workspaceId: workspaceId, permissions: original.permissions, color: original.color, isDefault: false, isSystem: false, createdById: userId });
    return duplicated;
  }
}




