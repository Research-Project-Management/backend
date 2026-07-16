import request from "supertest";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import { TaskModel } from "../../app/contexts/planning/task/task.schema.js";
import CycleModel from "../../app/contexts/planning/cycle/cycle.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";

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
import { TaskRepository } from "../../app/contexts/planning/task/task.repository.js";
import { TaskService } from "../../app/contexts/planning/task/task.service.js";
import { TaskController } from "../../app/contexts/planning/task/task.controller.js";
import { buildTaskRouter } from "../../app/contexts/planning/task/task.route.js";
import { errorHandler } from "../../app/middleware/error.middleware.js";

class MockFileRepo {
  async countByProject(projectId) { return 0; }
}

class MockTaskCommentRepo {
  async count(taskId) { return 0; }
  async aggregateCountByIds(taskIds) { return taskIds.map(id => ({ _id: id, count: 0 })); }
}

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
let taskRepo;
let taskService;
let taskController;
let taskRouter;

describe("Task Service Integration", () => {
  let owner, memberUser;
  let workspace;
  let project;
  let columnId;
  const roles = {};

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
    
    taskRepo = new TaskRepository();
    taskService = new TaskService({
      taskRepository: taskRepo,
      projectRepository: new ProjectRepository(), // for updates/cycles if needed
      taskCommentRepository: new MockTaskCommentRepo(),
      authRepository: userRepo
    });
    taskController = new TaskController({ taskService });

    projectRepo = new ProjectRepository();
    projectService = new ProjectService({
      projectRepository: projectRepo,
      fileRepository: new MockFileRepo(),
      taskRepository: taskRepo,
      roleRepository: roleRepo
    });
    projectController = new ProjectController({ projectService, workspaceService });

    workspaceRouter = buildWorkspaceRouter(workspaceController);
    projectRouter = buildProjectRouter(projectController);
    taskRouter = buildTaskRouter(taskController);

    // Mount routers
    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api", projectRouter);
    testApp.use("/api", taskRouter); // task router is mounted at /api and has /project/:projectId/tasks

    testApp.use(errorHandler);
  });

  beforeEach(async () => {
    // 1. Create owner and member users
    owner = await UserModel.create({
      email: "owner-task@test.com",
      password: "password123",
      firstName: "Task",
      lastName: "Owner",
    });

    memberUser = await UserModel.create({
      email: "member-task@test.com",
      password: "password123",
      firstName: "Task",
      lastName: "Member",
    });

    // 2. Create workspace via API to ensure proper setup
    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Task Test Workspace",
        url: "task-test-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;

    // Load roles
    const wsRoles = await RoleModel.find({ workspace: workspace._id });
    wsRoles.forEach((r) => {
      roles[r.name.toLowerCase()] = r._id;
    });

    // 3. Create project via API
    const projRes = await request(testApp)
      .post(`/api/workspace/${workspace._id}/projects`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Test Task Project",
        description: "A test project for tasks",
        color: "#ff0000"
      });
    project = projRes.body.project;

    // Add a column to the project
    const colRes = await request(testApp)
      .post(`/api/project/${project._id}/columns`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "To Do",
        color: "#0000ff"
      });
    columnId = colRes.body.project.taskColumns[0].id;
  });

  it("should create a new task", async () => {
    const res = await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "My First Task",
        description: "Task description",
        columnId: columnId,
        priority: "high"
      });

    expect(res.status).toBe(201);
    expect(res.body.task).toHaveProperty("_id");
    expect(res.body.task.title).toBe("My First Task");
    expect(res.body.task.priority).toBe("high");
    expect(res.body.task.columnId).toBe(columnId);
  });

  it("should get tasks for a project", async () => {
    // Create a task
    await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Test Task 1",
        columnId: columnId
      });

    const res = await request(testApp)
      .get(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBeGreaterThan(0);
    expect(res.body.tasks[0].title).toBe("Test Task 1");
  });

  it("should get a single task", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Single Task",
        columnId: columnId
      });
    const taskId = createRes.body.task._id;

    const res = await request(testApp)
      .get(`/api/project/${project._id}/tasks/${taskId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Single Task");
  });

  it("should update a task", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Task to Update",
        columnId: columnId
      });
    const taskId = createRes.body.task._id;

    const res = await request(testApp)
      .put(`/api/project/${project._id}/tasks/${taskId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Updated Task Name",
        priority: "low"
      });

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Updated Task Name");
    expect(res.body.task.priority).toBe("low");
  });

  it("should assign a task", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Task to Assign",
        columnId: columnId
      });
    const taskId = createRes.body.task._id;

    // First add member to workspace and project
    await request(testApp)
      .post(`/api/workspace/${workspace._id}/members`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ email: memberUser.email });

    await projectService.addMember(project._id, {
      userId: memberUser._id,
      role: roles.member.toString()
    }, owner._id);

    const res = await request(testApp)
      .put(`/api/project/${project._id}/tasks/${taskId}/assign`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        assignee: memberUser._id.toString()
      });

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.task.assignee._id.toString()).toBe(memberUser._id.toString());
  });

  it("should duplicate a task", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Task to Duplicate",
        columnId: columnId
      });
    const taskId = createRes.body.task._id;

    const res = await request(testApp)
      .post(`/api/project/${project._id}/tasks/${taskId}/duplicate`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(201);
    expect(res.body.task._id).not.toBe(taskId);
    expect(res.body.task.title).toMatch(/Task to Duplicate/);
  });

  it("should delete a task", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        title: "Task to Delete",
        columnId: columnId
      });
    const taskId = createRes.body.task._id;

    const res = await request(testApp)
      .delete(`/api/project/${project._id}/tasks/${taskId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(204);
    
    const checkRes = await request(testApp)
      .get(`/api/project/${project._id}/tasks/${taskId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
    
    expect(checkRes.status).toBe(404);
  });
});
