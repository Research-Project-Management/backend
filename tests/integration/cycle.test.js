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
import { CycleRepository } from "../../app/contexts/planning/cycle/cycle.repository.js";
import { CycleService } from "../../app/contexts/planning/cycle/cycle.service.js";
import { CycleController } from "../../app/contexts/planning/cycle/cycle.controller.js";
import { buildCycleRouter } from "../../app/contexts/planning/cycle/cycle.route.js";
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
let cycleRepo;
let cycleService;
let cycleController;
let cycleRouter;

describe("Cycle Service Integration", () => {
  let owner;
  let workspace;
  let project;

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
      projectRepository: new ProjectRepository(), 
      taskCommentRepository: new MockTaskCommentRepo(),
      authRepository: userRepo
    });
    taskController = new TaskController({ taskService });

    cycleRepo = new CycleRepository();
    cycleService = new CycleService({
      cycleRepository: cycleRepo,
      taskRepository: taskRepo,
      projectRepository: new ProjectRepository()
    });
    cycleController = new CycleController({ cycleService });

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
    cycleRouter = buildCycleRouter(cycleController);

    // Mount routers
    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api", projectRouter);
    testApp.use("/api", taskRouter);
    testApp.use("/api", cycleRouter);

    testApp.use(errorHandler);
  });

  beforeEach(async () => {
    owner = await UserModel.create({
      email: "owner-cycle@test.com",
      password: "password123",
      firstName: "Cycle",
      lastName: "Owner",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Cycle Test Workspace",
        url: "cycle-test-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;

    const projRes = await request(testApp)
      .post(`/api/workspace/${workspace._id}/projects`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Test Cycle Project",
        description: "A test project for cycles",
        color: "#ff0000"
      });
    project = projRes.body.project;
  });

  it("should create a new cycle", async () => {
    const res = await request(testApp)
      .post(`/api/project/${project._id}/cycles`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Sprint 1",
        phase: "data_collection"
      });

    if (res.status !== 201) console.log(res.body);
    expect(res.status).toBe(201);
    expect(res.body.cycle).toHaveProperty("_id");
    expect(res.body.cycle.name).toBe("Sprint 1");
    expect(res.body.cycle.phase).toBe("data_collection");
  });

  it("should get cycles for a project", async () => {
    await request(testApp)
      .post(`/api/project/${project._id}/cycles`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Sprint 2"
      });

    const res = await request(testApp)
      .get(`/api/project/${project._id}/cycles`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    if (res.status !== 200) console.log(res.body);
    expect(res.status).toBe(200);
    expect(res.body.cycles.length).toBeGreaterThan(0);
    expect(res.body.cycles[0].name).toBe("Sprint 2");
  });

  it("should get a single cycle", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/cycles`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ name: "Sprint 3" });
    const cycleId = createRes.body.cycle._id;

    const res = await request(testApp)
      .get(`/api/project/${project._id}/cycles/${cycleId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.cycle.name).toBe("Sprint 3");
  });

  it("should update a cycle", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/cycles`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ name: "Sprint 4" });
    const cycleId = createRes.body.cycle._id;

    const res = await request(testApp)
      .put(`/api/project/${project._id}/cycles/${cycleId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Sprint 4 - Updated",
        status: "active",
        startDate: new Date().toISOString(),
        endDate: new Date().toISOString()
      });

    expect(res.status).toBe(200);
    expect(res.body.cycle.name).toBe("Sprint 4 - Updated");
    expect(res.body.cycle.status).toBe("active");
  });

  it("should delete a cycle", async () => {
    const createRes = await request(testApp)
      .post(`/api/project/${project._id}/cycles`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ name: "Sprint 5" });
    const cycleId = createRes.body.cycle._id;

    const res = await request(testApp)
      .delete(`/api/project/${project._id}/cycles/${cycleId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);
    
    const checkRes = await request(testApp)
      .get(`/api/project/${project._id}/cycles/${cycleId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
    
    expect(checkRes.status).toBe(404);
  });
  
  it("should add a task to a cycle", async () => {
    const cycleRes = await request(testApp)
      .post(`/api/project/${project._id}/cycles`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ name: "Sprint 6" });
    const cycleId = cycleRes.body.cycle._id;
      
    // Add a column to project first for task creation
    const colRes = await request(testApp)
      .post(`/api/project/${project._id}/columns`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ title: "To Do" });
    const columnId = colRes.body.project.taskColumns[0].id;
    
    const taskRes = await request(testApp)
      .post(`/api/project/${project._id}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ title: "Task for cycle", columnId });
    const taskId = taskRes.body.task._id;
    
    const res = await request(testApp)
      .post(`/api/project/${project._id}/cycles/${cycleId}/tasks`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ taskId });
      
    expect(res.status).toBe(200);
    
    // Check if task is updated
    const checkTask = await request(testApp)
      .get(`/api/project/${project._id}/tasks/${taskId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
      
    if (!checkTask.body.task.cycle) console.log(checkTask.body);
    expect(checkTask.body.task.cycle.toString()).toBe(cycleId.toString());
  });
});
