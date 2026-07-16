import request from "supertest";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import { PageModel } from "../../app/contexts/manuscript/page/page.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import PageCommentModel from "../../app/contexts/collaboration/page-comment/page-comment.schema.js";

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

import { PageCommentRepository } from "../../app/contexts/collaboration/page-comment/page-comment.repository.js";
import { PageCommentService } from "../../app/contexts/collaboration/page-comment/page-comment.service.js";
import { PageCommentController } from "../../app/contexts/collaboration/page-comment/page-comment.controller.js";
import { buildCommentRouter } from "../../app/contexts/collaboration/page-comment/page-comment.route.js";
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
let pageCommentRepo;
let pageCommentService;
let pageCommentController;
let pageCommentRouter;

describe("Page Comment Service Integration", () => {
  let owner;
  let member;
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
    
    pageCommentRepo = new PageCommentRepository();
    pageCommentService = new PageCommentService({
      pageCommentRepository: pageCommentRepo
    });
    pageCommentController = new PageCommentController({ pageCommentService });

    projectRepo = new ProjectRepository();
    projectService = new ProjectService({
      projectRepository: projectRepo,
      fileRepository: new MockFileRepo(),
      taskRepository: { countByProject: async () => 0 }, // mock
      roleRepository: roleRepo
    });
    projectController = new ProjectController({ projectService, workspaceService });

    workspaceRouter = buildWorkspaceRouter(workspaceController);
    projectRouter = buildProjectRouter(projectController);
    pageCommentRouter = buildCommentRouter(pageCommentController);

    // Mount routers
    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api", projectRouter);
    // Page comment routes are /pages/:pageId/comments
    testApp.use("/api", pageCommentRouter); 

    testApp.use(errorHandler);
  });

  beforeEach(async () => {
    owner = await UserModel.create({
      email: "owner-pagecomment@test.com",
      password: "password123",
      firstName: "Page",
      lastName: "Owner",
    });

    member = await UserModel.create({
      email: "member-pagecomment@test.com",
      password: "password123",
      firstName: "Page",
      lastName: "Member",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Page Comment WS",
        url: "page-comment-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;

    const projRes = await request(testApp)
      .post(`/api/workspace/${workspace._id}/projects`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Page Comment Project",
        description: "A project for page comments",
        color: "#ff0000"
      });
    project = projRes.body.project;
    
    // Create a page directly in the DB
    page = await PageModel.create({
      project: project._id,
      title: "Test Page",
      content: "This is a test page",
      author: owner._id,
      path: "/test-page"
    });
    
    // Add member to project directly via db
    const role = await RoleModel.findOne({ name: "Member", workspace: workspace._id });
    await ProjectModel.findByIdAndUpdate(project._id, {
      $push: { members: { user: member._id, role: role._id } }
    });
  });

  it("should create a new page comment", async () => {
    const res = await request(testApp)
      .post(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        content: "This is a page comment",
        line: 1,
        lineEnd: 2
      });

    expect(res.status).toBe(201);
    expect(res.body.comment).toHaveProperty("_id");
    expect(res.body.comment.content).toBe("This is a page comment");
    expect(res.body.comment.line).toBe(1);
    expect(res.body.comment.lineEnd).toBe(2);
    expect(res.body.comment.author._id.toString()).toBe(owner._id.toString());
  });

  it("should get comments for a page", async () => {
    await request(testApp)
      .post(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        content: "Another comment"
      });

    const res = await request(testApp)
      .get(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.comments.length).toBeGreaterThan(0);
    expect(res.body.comments[0].content).toBe("Another comment");
  });

  it("should update a page comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Original comment" });
    const commentId = createRes.body.comment._id;

    const res = await request(testApp)
      .put(`/api/pages/${page._id}/comments/${commentId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        content: "Updated comment",
        status: "resolved"
      });

    expect(res.status).toBe(200);
    expect(res.body.comment.content).toBe("Updated comment");
    expect(res.body.comment.status).toBe("resolved");
    expect(res.body.comment.isEdited).toBe(true);
  });

  it("should prevent non-author from updating a comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Owner's comment" });
    const commentId = createRes.body.comment._id;

    const res = await request(testApp)
      .put(`/api/pages/${page._id}/comments/${commentId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", member._id.toString())
      .send({
        content: "Hacked comment"
      });

    expect(res.status).toBe(403);
  });

  it("should delete a page comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Comment to delete" });
    const commentId = createRes.body.comment._id;

    const res = await request(testApp)
      .delete(`/api/pages/${page._id}/comments/${commentId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());

    expect(res.status).toBe(204);
    
    const fetchRes = await request(testApp)
      .get(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString());
      
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.comments.length).toBe(0);
  });
  
  it("should add a reply to a comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Main comment" });
    const commentId = createRes.body.comment._id;
    
    const replyRes = await request(testApp)
      .post(`/api/pages/${page._id}/comments/${commentId}/replies`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", member._id.toString())
      .send({ content: "A reply from member" });
      
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.comment.replies.length).toBe(1);
    expect(replyRes.body.comment.replies[0].content).toBe("A reply from member");
    expect(replyRes.body.comment.replies[0].author._id.toString()).toBe(member._id.toString());
  });
  
  it("should delete a reply from a comment", async () => {
    const createRes = await request(testApp)
      .post(`/api/pages/${page._id}/comments`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({ content: "Main comment" });
    const commentId = createRes.body.comment._id;
    
    const replyRes = await request(testApp)
      .post(`/api/pages/${page._id}/comments/${commentId}/replies`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", member._id.toString())
      .send({ content: "A reply from member" });
      
    const replyId = replyRes.body.comment.replies[0]._id;
    
    const deleteRes = await request(testApp)
      .delete(`/api/pages/${page._id}/comments/${commentId}/replies/${replyId}`)
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", member._id.toString());
      
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.comment.replies.length).toBe(0);
  });
});
