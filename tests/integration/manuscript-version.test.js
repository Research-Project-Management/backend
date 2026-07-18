import request from "supertest";
import express from "express";
import mongoose from "mongoose";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import PageModel from "../../app/contexts/manuscript/page/page.schema.js";
import VersionModel from "../../app/contexts/manuscript/version/version.schema.js";

import { AuthRepository } from "../../app/contexts/identity/auth/auth.repository.js";
import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceController } from "../../app/contexts/organization/workspace/workspace.controller.js";
import { buildWorkspaceRouter } from "../../app/contexts/organization/workspace/workspace.route.js";

import { VersionRepository } from "../../app/contexts/manuscript/version/version.repository.js";
import { VersionService } from "../../app/contexts/manuscript/version/version.service.js";
import { VersionController } from "../../app/contexts/manuscript/version/version.controller.js";
import { buildVersionRouter } from "../../app/contexts/manuscript/version/version.route.js";
import { PageRepository } from "../../app/contexts/manuscript/page/page.repository.js";
import { errorHandler } from "../../app/middleware/error.middleware.js";

let testApp;
let userRepo;
let roleRepo;
let roleService;
let workspaceRepo;
let workspaceService;
let workspaceController;

let versionRepo;
let pageRepo;
let versionService;
let versionController;
let versionRouter;

describe("Manuscript Version Service Integration", () => {
  let owner;
  let workspace;
  let project;
  let page;

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
      roleService
    });
    workspaceController = new WorkspaceController({ workspaceService });
    const workspaceRouter = buildWorkspaceRouter(workspaceController);

    versionRepo = new VersionRepository();
    pageRepo = new PageRepository();
    versionService = new VersionService({ versionRepository: versionRepo, pageRepository: pageRepo });
    versionController = new VersionController({ versionService });

    versionRouter = buildVersionRouter(versionController);

    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api", versionRouter); // Routes already include /pages/:pageId and /project/...
    testApp.use(errorHandler);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await PageModel.deleteMany({});
    await VersionModel.deleteMany({});
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await PageModel.deleteMany({});
    await VersionModel.deleteMany({});

    owner = await UserModel.create({
      email: "owner-version@test.com",
      password: "password123",
      firstName: "Version",
      lastName: "Owner",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Version Workspace",
        url: "version-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;
    const ownerRole = await RoleModel.findOne({ name: "Owner", workspaceId: workspace._id });

    project = await ProjectModel.create({
      name: "Version Project",
      workspaceId: workspace._id,
      createdById: owner._id,
      members: [{ userId: owner._id, roleId: ownerRole._id }]
    });

    page = await PageModel.create({
      title: "Test Page",
      projectId: project._id,
      workspaceId: workspace._id,
      authorId: owner._id,
      content: "Initial content"
    });
  });

  it("should create a new version", async () => {
    const res = await request(testApp)
      .post(`/api/pages/${page._id}/versions`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Version 1",
        content: "Content v1",
        label: "v1",
        eventType: "manual_save"
      });

    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(201);
    expect(res.body.version).toHaveProperty("_id");
    expect(res.body.version.title).toBe("Test Page"); // Uses page title
    expect(res.body.version.page.toString()).toBe(page._id.toString());
  });

  it("should get history events", async () => {
    await VersionModel.create({
      page: page._id,
      projectPageId: page._id,
      title: "History Event",
      content: "Content v2",
      label: "v2",
      savedBy: owner._id,
      eventType: "manual_save"
    });

    const res = await request(testApp)
      .get(`/api/pages/${page._id}/history`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events[0].title).toBe("History Event");
  });

  it("should delete a version", async () => {
    const version = await VersionModel.create({
      page: page._id,
      title: "To Delete",
      content: "Del",
      savedBy: owner._id,
    });

    const res = await request(testApp)
      .delete(`/api/pages/${page._id}/versions/${version._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(204);

    const deleted = await VersionModel.findById(version._id);
    expect(deleted).toBeNull();
  });
});
