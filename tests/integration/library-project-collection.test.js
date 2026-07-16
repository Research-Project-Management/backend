import request from "supertest";
import express from "express";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import PaperModel from "../../app/contexts/library/paper/paper.schema.js";
import CollectionModel from "../../app/contexts/library/collection/collection.schema.js";
import ProjectCollectionModel from "../../app/contexts/library/project-collection/project-collection.schema.js";

import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceController } from "../../app/contexts/organization/workspace/workspace.controller.js";
import { buildWorkspaceRouter } from "../../app/contexts/organization/workspace/workspace.route.js";

import { PaperRepository } from "../../app/contexts/library/paper/paper.repository.js";
import { CollectionRepository } from "../../app/contexts/library/collection/collection.repository.js";
import { ProjectCollectionRepository } from "../../app/contexts/library/project-collection/project-collection.repository.js";
import { ProjectCollectionService } from "../../app/contexts/library/project-collection/project-collection.service.js";
import { ProjectCollectionController } from "../../app/contexts/library/project-collection/project-collection.controller.js";
import { buildProjectCollectionRouter } from "../../app/contexts/library/project-collection/project-collection.route.js";
import { errorHandler } from "../../app/middleware/error.middleware.js";
import { isAuthenticated } from "../../app/middleware/auth.middleware.js";

let testApp;
let roleRepo;
let roleService;
let workspaceRepo;
let workspaceService;
let workspaceController;

let pcRepo;
let collRepo;
let paperRepo;
let pcService;
let pcController;
let pcRouter;

describe("Library Project Collection Integration", () => {
  let owner;
  let workspace;
  let project;
  let libCollection;
  let paper1;
  let paper2;

  beforeAll(async () => {
    testApp = express();
    testApp.use(express.json());
    process.env.INTERNAL_API_KEY = "test-internal-key";
    
    // Auth bypass for testing
    testApp.use((req, res, next) => {
      if (req.headers["x-user-id"]) {
        req.user = { _id: req.headers["x-user-id"] };
      }
      next();
    });

    roleRepo = new RoleRepository();
    roleService = new RoleService({ roleRepository: roleRepo });
    
    workspaceRepo = new WorkspaceRepository();
    workspaceService = new WorkspaceService({
      workspaceRepository: workspaceRepo,
      roleService
    });
    workspaceController = new WorkspaceController({ workspaceService });
    const workspaceRouter = buildWorkspaceRouter(workspaceController);

    pcRepo = new ProjectCollectionRepository();
    collRepo = new CollectionRepository();
    paperRepo = new PaperRepository();
    pcService = new ProjectCollectionService({
      projectCollectionRepository: pcRepo,
      collectionRepository: collRepo,
      paperRepository: paperRepo
    });
    pcController = new ProjectCollectionController({ projectCollectionService: pcService });
    pcRouter = buildProjectCollectionRouter(pcController);

    testApp.use("/api/workspace", workspaceRouter);
    // Add isAuthenticated to route
    testApp.use("/api", isAuthenticated, pcRouter);
    testApp.use(errorHandler);
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await CollectionModel.deleteMany({});
    await PaperModel.deleteMany({});
    await ProjectCollectionModel.deleteMany({});
  });

  beforeEach(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await CollectionModel.deleteMany({});
    await PaperModel.deleteMany({});
    await ProjectCollectionModel.deleteMany({});

    owner = await UserModel.create({
      email: "owner-pc@test.com",
      password: "password123",
      firstName: "PC",
      lastName: "Owner",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "PC Workspace",
        url: "pc-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;
    const ownerRole = await RoleModel.findOne({ name: "Owner", workspace: workspace._id });

    project = await ProjectModel.create({
      name: "PC Project",
      workspace: workspace._id,
      createdBy: owner._id,
      members: [{ user: owner._id, role: ownerRole._id }]
    });

    libCollection = await CollectionModel.create({
      name: "Lib Col",
      workspace: workspace._id,
      createdBy: owner._id
    });

    paper1 = await PaperModel.create({
      title: "Paper 1",
      workspace: workspace._id,
      uploadedBy: owner._id,
      filename: "test1.pdf",
      fileUrl: "http://example.com/test1.pdf",
      collection: libCollection._id
    });

    paper2 = await PaperModel.create({
      title: "Paper 2",
      workspace: workspace._id,
      uploadedBy: owner._id,
      filename: "test2.pdf",
      fileUrl: "http://example.com/test2.pdf"
    });
  });

  it("should create a project collection", async () => {
    const res = await request(testApp)
      .post(`/api/project/${project._id}/collections`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Test PC",
        description: "Desc"
      });

    expect(res.status).toBe(201);
    expect(res.body.projectCollection).toHaveProperty("_id");
    expect(res.body.projectCollection.name).toBe("Test PC");
  });

  it("should get project collections", async () => {
    await ProjectCollectionModel.create({
      name: "Existing PC",
      project: project._id,
      workspace: workspace._id,
      createdBy: owner._id
    });

    const res = await request(testApp)
      .get(`/api/project/${project._id}/collections`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.projectCollections.length).toBeGreaterThan(0);
  });

  it("should import library collection", async () => {
    const pc = await ProjectCollectionModel.create({
      name: "PC to import to",
      project: project._id,
      workspace: workspace._id,
      createdBy: owner._id
    });

    const res = await request(testApp)
      .post(`/api/project/${project._id}/collections/${pc._id}/import-library`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        collectionId: libCollection._id.toString()
      });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1); // paper1 is in libCollection
    expect(res.body.projectCollection.papers.length).toBe(1);
  });

  it("should add a paper to project collection", async () => {
    const pc = await ProjectCollectionModel.create({
      name: "PC to add paper",
      project: project._id,
      workspace: workspace._id,
      createdBy: owner._id
    });

    const res = await request(testApp)
      .post(`/api/project/${project._id}/collections/${pc._id}/papers`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        paperId: paper2._id.toString(),
        note: "Great paper"
      });

    expect(res.status).toBe(201);
    expect(res.body.projectCollection.papers[0].paper.toString()).toBe(paper2._id.toString());
  });

  it("should remove a paper from project collection", async () => {
    const pc = await ProjectCollectionModel.create({
      name: "PC to remove paper from",
      project: project._id,
      workspace: workspace._id,
      createdBy: owner._id,
      papers: [{
        paper: paper2._id,
        addedBy: owner._id
      }]
    });

    const res = await request(testApp)
      .delete(`/api/project/${project._id}/collections/${pc._id}/papers/${paper2._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);

    const updated = await ProjectCollectionModel.findById(pc._id);
    expect(updated.papers.length).toBe(0);
  });

  it("should delete a project collection", async () => {
    const pc = await ProjectCollectionModel.create({
      name: "PC to delete",
      project: project._id,
      workspace: workspace._id,
      createdBy: owner._id
    });

    const res = await request(testApp)
      .delete(`/api/project/${project._id}/collections/${pc._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);

    const deleted = await ProjectCollectionModel.findById(pc._id);
    expect(deleted).toBeNull();
  });
});
