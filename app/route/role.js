import express from "express";
import RoleModel from "../schema/role.js";
import WorkspaceModel from "../schema/workspace.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";

const router = express.Router();

// Khởi tạo default roles cho workspace mới
export async function initializeDefaultRoles(workspaceId, userId) {
  const defaultRoles = [
    {
      name: "Owner",
      description: "Full access to all workspace features and settings",
      type: "workspace",
      workspace: workspaceId,
      isDefault: true,
      isSystem: true,
      color: "#ef4444",
      permissions: [
        {
          resource: "workspace",
          actions: ["create", "read", "update", "delete", "manage"],
        },
        {
          resource: "project",
          actions: ["create", "read", "update", "delete", "manage"],
        },
        { resource: "task", actions: ["create", "read", "update", "delete"] },
        { resource: "page", actions: ["create", "read", "update", "delete"] },
        {
          resource: "file",
          actions: ["create", "read", "update", "delete", "manage"],
        },
        { resource: "sticky", actions: ["create", "read", "update", "delete"] },
        {
          resource: "member",
          actions: ["create", "read", "update", "delete", "invite"],
        },
        { resource: "settings", actions: ["read", "update", "manage"] },
        { resource: "role", actions: ["create", "read", "update", "delete"] },
      ],
      createdBy: userId,
    },
    {
      name: "Admin",
      description:
        "Can manage most workspace features except critical settings",
      type: "workspace",
      workspace: workspaceId,
      isDefault: true,
      isSystem: true,
      color: "#f59e0b",
      permissions: [
        { resource: "workspace", actions: ["read", "update"] },
        {
          resource: "project",
          actions: ["create", "read", "update", "delete"],
        },
        { resource: "task", actions: ["create", "read", "update", "delete"] },
        { resource: "page", actions: ["create", "read", "update", "delete"] },
        { resource: "file", actions: ["create", "read", "update", "delete"] },
        { resource: "sticky", actions: ["create", "read", "update", "delete"] },
        { resource: "member", actions: ["read", "invite"] },
        { resource: "settings", actions: ["read"] },
        { resource: "role", actions: ["read"] },
      ],
      createdBy: userId,
    },
    {
      name: "Member",
      description: "Standard member with basic access",
      type: "workspace",
      workspace: workspaceId,
      isDefault: true,
      isSystem: true,
      color: "#3b82f6",
      permissions: [
        { resource: "workspace", actions: ["read"] },
        { resource: "project", actions: ["read"] },
        { resource: "task", actions: ["create", "read", "update"] },
        { resource: "page", actions: ["create", "read", "update"] },
        { resource: "file", actions: ["create", "read", "update"] },
        { resource: "sticky", actions: ["create", "read", "update"] },
        { resource: "member", actions: ["read"] },
        { resource: "settings", actions: ["read"] },
        { resource: "role", actions: ["read"] },
      ],
      createdBy: userId,
    },
  ];

  const createdRoles = await RoleModel.insertMany(defaultRoles);
  return {
    owner: createdRoles[0]._id,
    admin: createdRoles[1]._id,
    member: createdRoles[2]._id,
  };
}

// GET /api/roles/:workspaceId - Lấy tất cả roles của workspace
router.get(
  "/:workspaceId",
  isAuthenticated,
  checkWorkspaceRole("member"),
  async (req, res) => {
    try {
      const { workspaceId } = req.params;

      const roles = await RoleModel.find({
        workspace: workspaceId,
        type: "workspace",
      })
        .populate("createdBy", "name email avatar")
        .sort({ isSystem: -1, name: 1 });

      res.json({ roles });
    } catch (error) {
      console.error("Error fetching roles:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/roles/:workspaceId/:roleId - Lấy chi tiết role
router.get(
  "/:workspaceId/:roleId",
  isAuthenticated,
  checkWorkspaceRole("member"),
  async (req, res) => {
    try {
      const { roleId } = req.params;

      const role = await RoleModel.findById(roleId).populate(
        "createdBy",
        "name email avatar",
      );

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      res.json({ role });
    } catch (error) {
      console.error("Error fetching role:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// POST /api/roles/:workspaceId - Tạo role mới
router.post(
  "/:workspaceId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const { name, description, permissions, color } = req.body;

      // Kiểm tra tên role đã tồn tại
      const existingRole = await RoleModel.findOne({
        workspace: workspaceId,
        name: name.trim(),
      });

      if (existingRole) {
        return res.status(400).json({ error: "Role name already exists" });
      }

      const newRole = await RoleModel.create({
        name: name.trim(),
        description,
        type: "workspace",
        workspace: workspaceId,
        permissions: permissions || [],
        color: color || "#6366f1",
        isDefault: false,
        isSystem: false,
        createdBy: req.user._id,
      });

      await newRole.populate("createdBy", "name email avatar");

      res.status(201).json({ role: newRole });
    } catch (error) {
      console.error("Error creating role:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// PUT /api/roles/:workspaceId/:roleId - Cập nhật role
router.put(
  "/:workspaceId/:roleId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const { roleId } = req.params;
      const { name, description, permissions, color } = req.body;

      const role = await RoleModel.findById(roleId);

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Không cho phép sửa system roles
      if (role.isSystem) {
        return res.status(403).json({ error: "Cannot modify system roles" });
      }

      // Kiểm tra tên mới có bị trùng không
      if (name && name !== role.name) {
        const existingRole = await RoleModel.findOne({
          workspace: role.workspace,
          name: name.trim(),
          _id: { $ne: roleId },
        });

        if (existingRole) {
          return res.status(400).json({ error: "Role name already exists" });
        }
      }

      if (name) role.name = name.trim();
      if (description !== undefined) role.description = description;
      if (permissions) role.permissions = permissions;
      if (color) role.color = color;

      await role.save();
      await role.populate("createdBy", "name email avatar");

      res.json({ role });
    } catch (error) {
      console.error("Error updating role:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// DELETE /api/roles/:workspaceId/:roleId - Xóa role
router.delete(
  "/:workspaceId/:roleId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const { workspaceId, roleId } = req.params;

      const role = await RoleModel.findById(roleId);

      if (!role) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Không cho phép xóa system roles
      if (role.isSystem) {
        return res.status(403).json({ error: "Cannot delete system roles" });
      }

      // Kiểm tra xem có member nào đang dùng role này không
      const workspace = await WorkspaceModel.findById(workspaceId);
      const isRoleInUse = workspace.members.some(
        (m) => m.role.toString() === roleId,
      );

      if (isRoleInUse) {
        return res.status(400).json({
          error: "Cannot delete role that is currently assigned to members",
        });
      }

      await RoleModel.findByIdAndDelete(roleId);

      res.json({ message: "Role deleted successfully" });
    } catch (error) {
      console.error("Error deleting role:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// POST /api/roles/:workspaceId/:roleId/duplicate - Nhân bản role
router.post(
  "/:workspaceId/:roleId/duplicate",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const { workspaceId, roleId } = req.params;

      const originalRole = await RoleModel.findById(roleId);

      if (!originalRole) {
        return res.status(404).json({ error: "Role not found" });
      }

      // Tạo tên mới
      let newName = `${originalRole.name} (Copy)`;
      let counter = 1;
      while (
        await RoleModel.findOne({ workspace: workspaceId, name: newName })
      ) {
        counter++;
        newName = `${originalRole.name} (Copy ${counter})`;
      }

      const duplicatedRole = await RoleModel.create({
        name: newName,
        description: originalRole.description,
        type: originalRole.type,
        workspace: workspaceId,
        permissions: originalRole.permissions,
        color: originalRole.color,
        isDefault: false,
        isSystem: false,
        createdBy: req.user._id,
      });

      await duplicatedRole.populate("createdBy", "name email avatar");

      res.status(201).json({ role: duplicatedRole });
    } catch (error) {
      console.error("Error duplicating role:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

export default router;
