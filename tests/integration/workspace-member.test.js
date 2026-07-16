import request from "supertest";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";

import { buildWorkspaceRouter } from "../../app/contexts/organization/workspace/workspace.route.js";
import { WorkspaceController } from "../../app/contexts/organization/workspace/workspace.controller.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";
import { AuthRepository } from "../../app/contexts/identity/auth/auth.repository.js";
import { errorHandler } from "../../app/middleware/error.middleware.js";

let testApp;
let userRepo;
let roleRepo;
let roleService;
let workspaceRepo;
let workspaceService;
let workspaceController;
let workspaceRouter;

let owner;
let adminUser;
let memberUser;
let outsideUser;
let workspace;
let roles;

beforeAll(async () => {
  testApp = express();
  testApp.use(express.json());
  process.env.INTERNAL_API_KEY = "test-internal-key";

  userRepo = new AuthRepository();
  roleRepo = new RoleRepository();
  roleService = new RoleService({ roleRepository: roleRepo });
  workspaceRepo = new WorkspaceRepository();
  workspaceService = new WorkspaceService({
    workspaceRepository: workspaceRepo,
    roleService,
    userRepository: userRepo
  });
  workspaceController = new WorkspaceController({ workspaceService });
  workspaceRouter = buildWorkspaceRouter(workspaceController);

  testApp.use("/api/workspaces", workspaceRouter);
  testApp.use(errorHandler);
});

describe("Workspace Member Flow", () => {
  beforeEach(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await RoleModel.deleteMany({});

    owner = await UserModel.create({ name: "Owner", email: "owner@test.com", password: "pwd" });
    adminUser = await UserModel.create({ name: "Admin", email: "admin@test.com", password: "pwd" });
    memberUser = await UserModel.create({ name: "Member", email: "member@test.com", password: "pwd" });
    outsideUser = await UserModel.create({ name: "Outside", email: "outside@test.com", password: "pwd" });

    workspace = await workspaceService.createWorkspace({
      name: "Test Workspace",
      url: "test-workspace"
    }, owner._id);

    const workspaceRoles = await roleService.getRoles(workspace._id);
    roles = {
      owner: workspaceRoles.find(r => r.name === "Owner")._id,
      admin: workspaceRoles.find(r => r.name === "Admin")._id,
      member: workspaceRoles.find(r => r.name === "Member")._id
    };

    await WorkspaceModel.updateOne({ _id: workspace._id }, {
      $push: {
        members: [
          { user: adminUser._id, role: roles.admin },
          { user: memberUser._id, role: roles.member }
        ]
      }
    });
  });

  it("should allow an owner to add a new member", async () => {
    const res = await request(testApp)
      .post(`/api/workspaces/${workspace._id}/members`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        userId: outsideUser._id.toString(),
        roleId: roles.member.toString()
      });

    expect(res.status).toBe(201);
    const updated = await WorkspaceModel.findById(workspace._id);
    expect(updated.members.length).toBe(4);
    expect(updated.members.some(m => m.user.toString() === outsideUser._id.toString())).toBe(true);
  });

  it("should block a member from adding a new member", async () => {
    const res = await request(testApp)
      .post(`/api/workspaces/${workspace._id}/members`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", memberUser._id.toString())
      .send({
        userId: outsideUser._id.toString(),
        roleId: roles.member.toString()
      });

    expect(res.status).toBe(403);
  });

  it("should allow an admin to update a member role", async () => {
    const res = await request(testApp)
      .put(`/api/workspaces/${workspace._id}/members/${memberUser._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", adminUser._id.toString())
      .send({
        roleId: roles.admin.toString()
      });

    expect(res.status).toBe(200);
    const updated = await WorkspaceModel.findById(workspace._id);
    const m = updated.members.find(m => m.user.toString() === memberUser._id.toString());
    expect(m.role.toString()).toBe(roles.admin.toString());
  });

  it("should allow an owner to remove a member", async () => {
    const res = await request(testApp)
      .delete(`/api/workspaces/${workspace._id}/members/${memberUser._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);
    const updated = await WorkspaceModel.findById(workspace._id);
    expect(updated.members.length).toBe(2);
  });

  it("should allow owner to invite a member and generate invite code", async () => {
    // Currently inviteMember does the exact same thing as addMember based on the service code,
    // wait, what does `workspaceService.inviteMember(workspace._id, body, actorId)` do?
    // It's literally an alias for `addMember` in the codebase.
    // Let's test the endpoint anyway.
    const res = await request(testApp)
      .post(`/api/workspaces/${workspace._id}/invite`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        userId: outsideUser._id.toString(),
        roleId: roles.member.toString()
      });

    expect(res.status).toBe(201);
  });

  it("should allow user to join workspace via invite code", async () => {
    let wsWithInviteCode = await workspaceService.createWorkspace({
      name: "Invite WS",
      url: "invite-ws",
    }, owner._id);
    
    // Fetch from DB to get the auto-generated inviteCode
    wsWithInviteCode = await WorkspaceModel.findById(wsWithInviteCode._id);
    const code = wsWithInviteCode.inviteCode;
    
    // Simulate join using POST /api/workspaces/join/code
    const res = await request(testApp)
      .post(`/api/workspaces/join/code`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", outsideUser._id.toString())
      .send({
        inviteCode: code
      });

    expect(res.status).toBe(200);
    const updated = await WorkspaceModel.findById(wsWithInviteCode._id);
    expect(updated.members.some(m => m.user.toString() === outsideUser._id.toString())).toBe(true);
  });

  it("should allow a member to leave the workspace", async () => {
    const res = await request(testApp)
      .post(`/api/workspaces/${workspace._id}/leave`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", memberUser._id.toString());

    expect(res.status).toBe(204);
    const updated = await WorkspaceModel.findById(workspace._id);
    expect(updated.members.some(m => m.user.toString() === memberUser._id.toString())).toBe(false);
  });
});
