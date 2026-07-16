import request from "supertest";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";

import { buildWorkspaceRouter } from "../../app/contexts/organization/workspace/workspace.route.js";
import { WorkspaceController } from "../../app/contexts/organization/workspace/workspace.controller.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";

import { buildProjectRouter } from "../../app/contexts/organization/project/project.route.js";
import { ProjectController } from "../../app/contexts/organization/project/project.controller.js";
import { ProjectService } from "../../app/contexts/organization/project/project.service.js";
import { ProjectRepository } from "../../app/contexts/organization/project/project.repository.js";
import FileModel from "../../app/contexts/shared/file/file.schema.js"; // Needs mock repo or model
// actually wait, file and task repos:
class MockFileRepo {
  async countByProject(projectId) { return 0; }
}
class MockTaskRepo {
  async countByProject(projectId) { return 0; }
}

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
let projectRepo;
let projectService;
let projectController;
let projectRouter;


describe("Project Service Integration", () => {
  let owner;
  let memberUser;
  let workspace;
  let project;
  let roles = {};

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
    
    projectRepo = new ProjectRepository();
    projectService = new ProjectService({
      projectRepository: projectRepo,
      fileRepository: new MockFileRepo(),
      taskRepository: new MockTaskRepo(),
      roleRepository: roleRepo
    });
    projectController = new ProjectController({ projectService, workspaceService });

    workspaceRouter = buildWorkspaceRouter(workspaceController);
    projectRouter = buildProjectRouter(projectController);

    // Mount routers
    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api", projectRouter);

    testApp.use((req, res, next) => {
      console.log("404 Hit:", req.method, req.url);
      next();
    });

    testApp.use(errorHandler);
  });

  beforeEach(async () => {
    owner = await UserModel.create({
      name: "Project Owner",
      email: "projectowner@example.com",
      password: "password123",
      avatar: "avatar.jpg",
    });

    memberUser = await UserModel.create({
      name: "Project Member",
      email: "projectmember@example.com",
      password: "password123",
      avatar: "avatar.jpg",
    });

    // Create a workspace to hold projects
    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Project Test Workspace",
        url: "project-test-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;

    const wsRoles = await RoleModel.find({ workspace: workspace._id });
    wsRoles.forEach((r) => {
      roles[r.name.toLowerCase()] = r._id;
    });

    // Seed a project for the rest of the tests to use
    const projRes = await request(testApp)
      .post(`/api/project/${workspace._id}/projects`) // Wait, the route is /api/workspace/:workspaceId/projects
      // But wait! projectRouter is mounted at /api, so the route is /api/workspace/:workspaceId/projects
      // No wait! Earlier I fixed project paths but not the creation path?
      // Let's just create it directly via service or correct endpoint
    // To be safe, use the service:
    project = await projectService.createProject(workspace._id, {
      name: "Test Project",
      description: "A test project",
      color: "#ff0000"
    }, owner._id);
  });

  afterAll(async () => {
    // await closeDatabase(); // handled by setup.js in jest
  });

  it("should create a new project via API", async () => {
    const res = await request(testApp)
      .post(`/api/workspace/${workspace._id}/projects`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Another Test Project",
        description: "A test project",
        color: "#ff0000",
      });

    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe("Another Test Project");
  });

  it("should get project overview", async () => {
    const res = await request(testApp)
      .get(`/api/project/${project._id}/overview`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe("Test Project");
    // Ensure task and file counts are returned
    expect(res.body.taskCount).toBeDefined();
    expect(res.body.fileCount).toBeDefined();
  });

  it("should update the project", async () => {
    const res = await request(testApp)
      .put(`/api/project/${project._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Updated Project Name",
        description: "Updated description",
      });

    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe("Updated Project Name");
    expect(res.body.project.description).toBe("Updated description");
  });

  it("should add a member to the project", async () => {
    const res = await request(testApp)
      .post(`/api/project/${project._id}/members`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        userId: memberUser._id.toString(),
        role: roles.member.toString(),
      });

    expect(res.status).toBe(201);
    const updatedProject = await ProjectModel.findById(project._id);
    expect(updatedProject.members.some(m => m.user.toString() === memberUser._id.toString())).toBe(true);
  });

  it("should update a member role in the project", async () => {
    // First, add the member
    await projectService.addMember(project._id, {
      userId: memberUser._id,
      roleId: roles.member
    }, owner._id);

    const res = await request(testApp)
      .put(`/api/project/${project._id}/members/${memberUser._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        role: roles.admin.toString(),
      });

    expect(res.status).toBe(200);
    const updatedProject = await ProjectModel.findById(project._id);
    const member = updatedProject.members.find(m => m.user.toString() === memberUser._id.toString());
    expect(member.role.toString()).toBe(roles.admin.toString());
  });

  it("should remove a member from the project", async () => {
    // First, add the member
    await projectService.addMember(project._id, {
      userId: memberUser._id,
      roleId: roles.member
    }, owner._id);

    const res = await request(testApp)
      .delete(`/api/project/${project._id}/members/${memberUser._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);
    const updatedProject = await ProjectModel.findById(project._id);
    expect(updatedProject.members.some(m => m.user.toString() === memberUser._id.toString())).toBe(false);
  });

  it("should list projects in workspace", async () => {
    const res = await request(testApp)
      .get(`/api/workspace/${workspace._id}/projects`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.projects.length).toBeGreaterThan(0);
    expect(res.body.projects[0].name).toBe("Test Project");
  });

  it("should delete the project", async () => {
    const res = await request(testApp)
      .delete(`/api/project/${project._id}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);
    const deletedProject = await ProjectModel.findById(project._id);
    expect(deletedProject).toBeNull();
  });
});
