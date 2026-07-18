import request from "supertest";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { jest } from "@jest/globals";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import PageModel from "../../app/contexts/manuscript/page/page.schema.js";

import { AuthRepository } from "../../app/contexts/identity/auth/auth.repository.js";
import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";

import { PageRepository } from "../../app/contexts/manuscript/page/page.repository.js";
import { PageService } from "../../app/contexts/manuscript/page/page.service.js";
import { PageController } from "../../app/contexts/manuscript/page/page.controller.js";
import { buildPageRouter } from "../../app/contexts/manuscript/page/page.route.js";
import { errorHandler } from "../../app/middleware/error.middleware.js";

let testApp;
let userRepo;
let roleRepo;
let roleService;
let workspaceRepo;
let workspaceService;

let pageRepo;
let pageService;
let pageController;
let pageRouter;

describe("Manuscript Page Service Integration", () => {
  let owner;
  let workspace;
  let project;
  let mongod;

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
    
    pageRepo = new PageRepository();
    
    // Mock FileService
    const mockFileService = {
      presign: jest.fn().mockResolvedValue({ url: "http://presigned.url" }),
      getPageFiles: jest.fn().mockResolvedValue([]),
      deleteFile: jest.fn().mockResolvedValue(true),
      getFile: jest.fn().mockResolvedValue({ url: "/api/files/test-key" }),
      proxyR2: jest.fn().mockImplementation((key, res) => res.send("file-content"))
    };

    pageService = new PageService({ pageRepository: pageRepo });
    // mock syncProject since it calls compiler-sync which may fail without env
    pageService.syncProject = jest.fn().mockResolvedValue({ synced: true, fileCount: 1 });

    pageController = new PageController({ 
      pageService, 
      fileService: mockFileService 
    });

    pageRouter = buildPageRouter(pageController);

    // Mount routers
    testApp.use("/api", pageRouter);

    testApp.use(errorHandler);

    // Setup workspace router to allow creating workspaces via API
    const { buildWorkspaceRouter } = await import("../../app/contexts/organization/workspace/workspace.route.js");
    const { WorkspaceController } = await import("../../app/contexts/organization/workspace/workspace.controller.js");
    
    workspaceController = new WorkspaceController({ workspaceService });
    const workspaceRouter = buildWorkspaceRouter(workspaceController);
    testApp.use("/api/workspace", workspaceRouter);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await PageModel.deleteMany({});
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await PageModel.deleteMany({});

    owner = await UserModel.create({
      email: "owner-page@test.com",
      password: "password123",
      firstName: "Page",
      lastName: "Owner",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Page Workspace",
        url: "page-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;

    const ownerRole = await RoleModel.findOne({ name: "Owner", workspaceId: workspace._id });

    project = await ProjectModel.create({
      name: "Page Project",
      workspaceId: workspace._id,
      createdById: owner._id,
      members: [{ userId: owner._id, roleId: ownerRole._id }]
    });
  });

  it("should create a new root page", async () => {
    const res = await request(testApp)
      .post(`/api/project/${project._id}/pages`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Introduction Page",
      });
      
    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(201);
    expect(res.body.page).toHaveProperty("_id");
    expect(res.body.page.title).toBe("Introduction Page");
    expect(res.body.mainFile).toHaveProperty("_id");
    expect(res.body.mainFile.title).toBe("main.tex");
  });

  it("should get pages for a project", async () => {
    await PageModel.create({
      title: "Existing Page",
      projectId: project._id,
      workspaceId: workspace._id,
      authorId: owner._id,
    });

    const res = await request(testApp)
      .get(`/api/project/${project._id}/pages`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
      
    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(200);
    expect(res.body.pages.length).toBeGreaterThan(0);
    expect(res.body.pages[0].title).toBe("Existing Page");
  });

  it("should create a child page", async () => {
    const rootPage = await PageModel.create({
      title: "Root Page",
      projectId: project._id,
      workspaceId: workspace._id,
      authorId: owner._id,
    });

    const res = await request(testApp)
      .post(`/api/pages/${rootPage._id}/files`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "section1.tex",
        content: "Hello Section 1",
      });

    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(201);
    expect(res.body.file).toHaveProperty("_id");
    expect(res.body.file.title).toBe("section1.tex");
    expect(res.body.file.parentPage.toString()).toBe(rootPage._id.toString());
  });

  it("should update a page", async () => {
    const page = await PageModel.create({
      title: "Old Title",
      projectId: project._id,
      workspaceId: workspace._id,
      authorId: owner._id,
    });

    const res = await request(testApp)
      .put(`/api/pages/${page._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "New Title",
      });

    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(200);
    expect(res.body.page.title).toBe("New Title");
  });

  it("should get a specific page", async () => {
    const page = await PageModel.create({
      title: "Specific Page",
      projectId: project._id,
      workspaceId: workspace._id,
      authorId: owner._id,
    });

    const res = await request(testApp)
      .get(`/api/pages/${page._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(200);
    expect(res.body.page.title).toBe("Specific Page");
  });

  it("should delete a page", async () => {
    const page = await PageModel.create({
      title: "Page To Delete",
      projectId: project._id,
      workspaceId: workspace._id,
      authorId: owner._id,
    });

    const res = await request(testApp)
      .delete(`/api/pages/${page._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    if (res.status === 500) console.log(res.body);

    expect(res.status).toBe(204);

    const deletedPage = await PageModel.findById(page._id);
    expect(deletedPage).toBeNull();
  });
});
