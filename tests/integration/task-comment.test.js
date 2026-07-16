import request from "supertest";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import { TaskModel } from "../../app/contexts/planning/task/task.schema.js";
import CycleModel from "../../app/contexts/planning/cycle/cycle.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import TaskCommentModel from "../../app/contexts/collaboration/task-comment/task-comment.schema.js";

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
import { TaskCommentRepository } from "../../app/contexts/collaboration/task-comment/task-comment.repository.js";
import { TaskCommentService } from "../../app/contexts/collaboration/task-comment/task-comment.service.js";
import { TaskCommentController } from "../../app/contexts/collaboration/task-comment/task-comment.controller.js";
import { buildTaskCommentRouter } from "../../app/contexts/collaboration/task-comment/task-comment.route.js";
import { errorHandler } from "../../app/middleware/error.middleware.js";

class MockFileRepo {
  async countByProject(projectId) { return 0; }
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
let taskCommentRepo;
let taskCommentService;
let taskCommentController;
let taskCommentRouter;

describe("Task Comment Service Integration", () => {
  let owner;
  let member;
  let workspace;
  let project;
  let task;

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
    
    taskCommentRepo = new TaskCommentRepository();
    
    taskRepo = new TaskRepository();
    taskService = new TaskService({
      taskRepository: taskRepo,
      projectRepository: new ProjectRepository(), 
      taskCommentRepository: taskCommentRepo,
      authRepository: userRepo
    });
    taskController = new TaskController({ taskService });

    taskCommentService = new TaskCommentService({
      taskCommentRepository: taskCommentRepo,
      taskRepository: taskRepo
    });
    taskCommentController = new TaskCommentController({ taskCommentService });

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
    taskCommentRouter = buildTaskCommentRouter(taskCommentController);

    // Mount routers
    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api", projectRouter);
    testApp.use("/api/project/:projectId", taskRouter); // Mount with projectId since the route uses it, wait task routes are already under /project/:projectId in route file? 
    // Wait, task router mounts /project/:projectId/tasks
    testApp.use("/api", taskRouter);
    
    // Task comment routes use /tasks/:taskId/comments
    // Wait, let's see how they are exported.
    testApp.use("/api/project/:projectId", taskCommentRouter); // If they check project ID...
    testApp.use("/api", taskCommentRouter); 
    // Actually the middleware checks req.params.taskId for checkTaskRole. So the route should be /api/tasks/:taskId/comments

    testApp.use(errorHandler);
  });

  beforeEach(async () => {
    owner = await UserModel.create({
      email: "owner-comment@test.com",
      password: "password123",
      firstName: "Comment",
      lastName: "Owner",
    });

    member = await UserModel.create({
      email: "member-comment@test.com",
      password: "password123",
      firstName: "Comment",
      lastName: "Member",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Comment Test Workspace",
        url: "comment-test-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;

    const projRes = await request(testApp)
      .post(`/api/workspace/${workspace._id}/projects`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Test Comment Project",
        description: "A test project for comments",
        color: "#ff0000"
      });
    project = projRes.body.project;
    
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
      .send({
        title: "Test Task 1",
        columnId: columnId
      });
    task = taskRes.body.task;
    
    // Add member to project directly via db
    const role = await RoleModel.findOne({ name: "Member", workspace: workspace._id });
    await ProjectModel.findByIdAndUpdate(project._id, {
      $push: { members: { user: member._id, role: role._id } }
    });
  });

  it("should create a new task comment", async () => {
    const res = await request(testApp)
      .post(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        content: "This is a test comment"
      });

    expect(res.status).toBe(201);
    expect(res.body.comment).toHaveProperty("_id");
    expect(res.body.comment.content).toBe("This is a test comment");
    expect(res.body.comment.author._id.toString()).toBe(owner._id.toString());
  });

  it("should get comments for a task", async () => {
    await request(testApp)
      .post(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        content: "This is a test comment 2"
      });

    const res = await request(testApp)
      .get(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.comments.length).toBeGreaterThan(0);
    expect(res.body.comments[0].content).toBe("This is a test comment 2");
  });

  it("should update a task comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Original comment" });
    const commentId = createRes.body.comment._id;

    const res = await request(testApp)
      .put(`/api/tasks/${task._id}/comments/${commentId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        content: "Updated comment"
      });

    expect(res.status).toBe(200);
    expect(res.body.comment.content).toBe("Updated comment");
    expect(res.body.comment.isEdited).toBe(true);
  });

  it("should prevent non-author from updating a comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Owner's comment" });
    const commentId = createRes.body.comment._id;

    const res = await request(testApp)
      .put(`/api/tasks/${task._id}/comments/${commentId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", member._id.toString())
      .send({
        content: "Hacked comment"
      });

    expect(res.status).toBe(403);
  });

  it("should delete a task comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Comment to delete" });
    const commentId = createRes.body.comment._id;

    const res = await request(testApp)
      .delete(`/api/tasks/${task._id}/comments/${commentId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);
    
    const countRes = await request(testApp)
      .get(`/api/tasks/${task._id}/comments/count`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
      
    expect(countRes.status).toBe(200);
    expect(countRes.body.count).toBe(0);
  });
  
  it("should add a reply to a comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Main comment" });
    const commentId = createRes.body.comment._id;
    
    const replyRes = await request(testApp)
      .post(`/api/tasks/${task._id}/comments/${commentId}/replies`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", member._id.toString())
      .send({ content: "A reply from member" });
      
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.comment.replies.length).toBe(1);
    expect(replyRes.body.comment.replies[0].content).toBe("A reply from member");
    expect(replyRes.body.comment.replies[0].author._id.toString()).toBe(member._id.toString());
  });
  
  it("should add a reaction to a comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/tasks/${task._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "React to this" });
    const commentId = createRes.body.comment._id;
    
    const reactRes = await request(testApp)
      .put(`/api/tasks/${task._id}/comments/${commentId}/reaction`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", member._id.toString())
      .send({ emoji: "👍" });
      
    expect(reactRes.status).toBe(200);
    expect(reactRes.body.comment.reactions.length).toBe(1);
    expect(reactRes.body.comment.reactions[0].emoji).toBe("👍");
  });
});
