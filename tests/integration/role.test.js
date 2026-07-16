import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";

import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";
import { AuthRepository } from "../../app/contexts/identity/auth/auth.repository.js";

let userRepo;
let roleRepo;
let roleService;
let workspaceRepo;
let workspaceService;

let owner;
let workspace;
let roles;

beforeAll(async () => {
  userRepo = new AuthRepository();
  roleRepo = new RoleRepository();
  roleService = new RoleService({ roleRepository: roleRepo, workspaceRepository: new WorkspaceRepository() });
  workspaceRepo = new WorkspaceRepository();
  workspaceService = new WorkspaceService({
    workspaceRepository: workspaceRepo,
    roleService,
    userRepository: userRepo
  });
});

describe("Role Service Integration", () => {
  beforeEach(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await RoleModel.deleteMany({});

    owner = await UserModel.create({ name: "Owner", email: "owner@test.com", password: "pwd" });

    workspace = await workspaceService.createWorkspace({
      name: "Role Test WS",
      url: "role-test-ws"
    }, owner._id);

    const workspaceRoles = await roleService.getRoles(workspace._id);
    roles = {
      owner: workspaceRoles.find(r => r.name === "Owner")._id,
      admin: workspaceRoles.find(r => r.name === "Admin")._id,
      member: workspaceRoles.find(r => r.name === "Member")._id
    };
  });

  it("should create a new custom role", async () => {
    const customRole = await roleService.createRole(workspace._id, {
      name: "Custom Role",
      description: "Custom test",
      permissions: [{ resource: "task", actions: ["read", "update"] }],
      color: "#ffffff"
    }, owner._id);

    expect(customRole).toBeDefined();
    expect(customRole.name).toBe("Custom Role");
    expect(customRole.isSystem).toBe(false);
    expect(customRole.permissions[0].resource).toBe("task");
  });

  it("should not allow creating a role with duplicate name", async () => {
    await expect(
      roleService.createRole(workspace._id, {
        name: "Admin",
        description: "Should fail",
        permissions: []
      }, owner._id)
    ).rejects.toThrow("Role name already exists");
  });

  it("should allow updating a custom role", async () => {
    const customRole = await roleService.createRole(workspace._id, {
      name: "Custom",
      permissions: []
    }, owner._id);

    const updated = await roleService.updateRole(customRole._id, {
      name: "Custom Updated",
      color: "#000000"
    });

    expect(updated.name).toBe("Custom Updated");
    expect(updated.color).toBe("#000000");
  });

  it("should not allow modifying a system role", async () => {
    await expect(
      roleService.updateRole(roles.owner, { name: "Hacked Owner" })
    ).rejects.toThrow("Cannot modify system roles");
  });

  it("should allow deleting a custom role not assigned to anyone", async () => {
    const customRole = await roleService.createRole(workspace._id, {
      name: "To Delete",
      permissions: []
    }, owner._id);

    await roleService.deleteRole(workspace._id, customRole._id);
    const found = await roleService.getRole(customRole._id);
    expect(found).toBeNull();
  });

  it("should not allow deleting a role assigned to members", async () => {
    // Member role is assigned to the Owner because they created the workspace... Wait, owner is assigned Owner role.
    await WorkspaceModel.updateOne({ _id: workspace._id }, {
      $push: {
        members: [{ user: owner._id, role: roles.member }]
      }
    });

    await expect(
      roleService.deleteRole(workspace._id, roles.member)
    ).rejects.toThrow("Cannot delete system roles");
  });

  it("should duplicate a role correctly", async () => {
    const customRole = await roleService.createRole(workspace._id, {
      name: "Original",
      permissions: [{ resource: "page", actions: ["read"] }]
    }, owner._id);

    const duplicated = await roleService.duplicateRole(workspace._id, customRole._id, owner._id);
    expect(duplicated.name).toBe("Original (Copy)");
    expect(duplicated.permissions[0].resource).toBe("page");
    
    const duplicatedAgain = await roleService.duplicateRole(workspace._id, customRole._id, owner._id);
    expect(duplicatedAgain.name).toBe("Original (Copy 2)");
  });
});
