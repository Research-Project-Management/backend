import request from "supertest";
import express from "express";
import mongoose from "mongoose";
import { jest } from "@jest/globals";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import FileModel from "../../app/contexts/shared/file/file.schema.js";

import { AuthRepository } from "../../app/contexts/identity/auth/auth.repository.js";
import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceController } from "../../app/contexts/organization/workspace/workspace.controller.js";
import { buildWorkspaceRouter } from "../../app/contexts/organization/workspace/workspace.route.js";

import { ProjectRepository } from "../../app/contexts/organization/project/project.repository.js";
import { ProjectService } from "../../app/contexts/organization/project/project.service.js";
import { ProjectController } from "../../app/contexts/organization/project/project.controller.js";
import { buildProjectRouter } from "../../app/contexts/organization/project/project.route.js";

import { FileRepository } from "../../app/contexts/shared/file/file.repository.js";
import { FileService } from "../../app/contexts/shared/file/file.service.js";
import { FileController } from "../../app/contexts/shared/file/file.controller.js";
import { buildFileRouter } from "../../app/contexts/shared/file/file.route.js";
import { CrossrefClient } from "../../app/lib/crossref.js";

import { errorHandler } from "../../app/middleware/error.middleware.js";

let testApp;
let userRepo;
let roleRepo;
let roleService;
let workspaceRepo;
let workspaceService;
let workspaceController;
let workspaceRouter;
let projectRepo;
let projectService;
let projectController;
let projectRouter;
let fileRepo;
let fileService;
let fileController;
let fileRouter;

describe("Workspace Storage API Integration", () => {
  let owner;
  let member;
  let workspace;
  let project;
  let originalFetch;

  beforeAll(async () => {
    testApp = express();
    testApp.use(express.json());
    process.env.INTERNAL_API_KEY = "test-internal-key";
    process.env.R2_BUCKET_NAME = "test-bucket";

    // Setup mocks
    originalFetch = global.fetch;

    userRepo = new AuthRepository();
    roleRepo = new RoleRepository();
    roleService = new RoleService({ roleRepository: roleRepo });

    workspaceRepo = new WorkspaceRepository();
    workspaceService = new WorkspaceService({
      workspaceRepository: workspaceRepo,
      roleService
    });
    workspaceController = new WorkspaceController({ workspaceService });

    projectRepo = new ProjectRepository();
    projectService = new ProjectService({
      projectRepository: projectRepo,
      workspaceRepository: workspaceRepo,
      roleService
    });
    projectController = new ProjectController({ projectService });

    fileRepo = new FileRepository();
    const mockCrossrefClient = new CrossrefClient();
    fileService = new FileService({
      fileRepository: fileRepo,
      projectRepository: projectRepo,
      crossrefClient: mockCrossrefClient
    });
    fileController = new FileController({ fileService });

    workspaceRouter = buildWorkspaceRouter(workspaceController);
    projectRouter = buildProjectRouter(projectController);
    fileRouter = buildFileRouter(fileController);

    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api/project", projectRouter);
    testApp.use("/api/files", fileRouter);

    testApp.use(errorHandler);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(async () => {
    owner = await UserModel.create({
      email: "owner-storage@test.com",
      password: "password123",
      firstName: "Storage",
      lastName: "Owner",
    });

    member = await UserModel.create({
      email: "member-storage@test.com",
      password: "password123",
      firstName: "Storage",
      lastName: "Member",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Storage WS",
        url: "storage-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;

    // Add member to workspace
    const role = await RoleModel.findOne({ name: "Member", workspaceId: workspace._id });
    await WorkspaceModel.findByIdAndUpdate(workspace._id, {
      $push: { members: { userId: member._id, roleId: role._id } }
    });

    // Create a project in the workspace
    const projRes = await request(testApp)
      .post(`/api/project/workspace/${workspace._id}/projects`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Test Project",
        description: "Test description"
      });
    project = projRes.body.project;
  });

  it("should create a presigned url", async () => {
    const res = await request(testApp)
      .post("/api/files/presign")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        filename: "workspace/test.txt"
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("url");
    expect(res.body.path).toBe("workspace/test.txt");
  });

  it("should block presign for disallowed path prefixes", async () => {
    const res = await request(testApp)
      .post("/api/files/presign")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        filename: "invalid/test.txt"
      });

    expect(res.status).toBe(403);
  });

  it("should upload file metadata and retrieve it", async () => {
    const uploadRes = await request(testApp)
      .post("/api/files/upload")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        filename: "test-file.txt",
        size: 1024,
        mimeType: "text/plain",
        url: "/api/files/r2/workspace/test-file.txt",
        workspaceId: workspace._id.toString(),
        scope: "workspace"
      });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.file).toHaveProperty("_id");
    expect(uploadRes.body.file.filename).toBe("test-file.txt");

    const getRes = await request(testApp)
      .get(`/api/files/${uploadRes.body.file._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(getRes.status).toBe(200);
    expect(getRes.body.file.filename).toBe("test-file.txt");
  });

  it("should create a folder inside workspace", async () => {
    const res = await request(testApp)
      .post("/api/files/folder")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "My Folder",
        workspaceId: workspace._id.toString(),
        scope: "workspace"
      });

    expect(res.status).toBe(201);
    expect(res.body.folder).toHaveProperty("_id");
    expect(res.body.folder.filename).toBe("My Folder");
    expect(res.body.folder.isFolder).toBe(true);
  });

  it("should star, rename, move, and trash files", async () => {
    const folderRes = await request(testApp)
      .post("/api/files/folder")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Dest Folder",
        workspaceId: workspace._id.toString(),
        scope: "workspace"
      });
    const folderId = folderRes.body.folder._id;

    const fileRes = await request(testApp)
      .post("/api/files/upload")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        filename: "mutable.txt",
        size: 500,
        mimeType: "text/plain",
        url: "/api/files/r2/workspace/mutable.txt",
        workspaceId: workspace._id.toString(),
        scope: "workspace"
      });
    const fileId = fileRes.body.file._id;

    // Star file
    const starRes = await request(testApp)
      .put(`/api/files/${fileId}/star`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
    expect(starRes.status).toBe(200);
    expect(starRes.body.file.starred).toBe(true);

    // Rename file
    const renameRes = await request(testApp)
      .put(`/api/files/${fileId}/rename`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ name: "renamed.txt" });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.file.filename).toBe("renamed.txt");

    // Move file
    const moveRes = await request(testApp)
      .put(`/api/files/${fileId}/move`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ parentId: folderId });
    expect(moveRes.status).toBe(200);
    expect(moveRes.body.file.parent.toString()).toBe(folderId.toString());

    // Trash file
    const deleteRes = await request(testApp)
      .delete(`/api/files/${fileId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
    expect(deleteRes.status).toBe(204);

    // Starred files list should exclude trashed files
    const starredListRes = await request(testApp)
      .get(`/api/files/workspace/${workspace._id}/starred`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
    expect(starredListRes.body.files.length).toBe(0);

    // Starred trashed file query verifies star toggle
    const dbFile = await FileModel.findById(fileId);
    expect(dbFile.trashedAt).not.toBeNull();

    // Restore file
    const restoreRes = await request(testApp)
      .put(`/api/files/${fileId}/restore`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.file.trashedAt).toBeNull();
  });

  it("should mock crossref search correctly", async () => {
    global.fetch = async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: {
            items: [
              {
                DOI: "10.1000/xyz123",
                title: ["Crossref Test Paper"],
                author: [{ family: "Tester", given: "John" }],
                issued: { "date-parts": [[2026, 7, 1]] },
                publisher: "Test Publisher",
                type: "journal-article"
              }
            ],
            "total-results": 1
          }
        })
      };
    };

    const res = await request(testApp)
      .get("/api/files/crossref/search?query=test")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.works.length).toBe(1);
    expect(res.body.works[0].title).toBe("Crossref Test Paper");
    expect(res.body.works[0].doi).toBe("10.1000/xyz123");
  });
});
