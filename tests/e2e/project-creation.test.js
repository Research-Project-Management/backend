import request from "supertest";
import express from "express";
import session from "express-session";
import passport from "passport";
import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";

// Import routers and dependencies
import { buildAuthRouter } from "../../app/contexts/identity/auth/auth.route.js";
import { AuthController } from "../../app/contexts/identity/auth/auth.controller.js";
import { AuthService } from "../../app/contexts/identity/auth/auth.service.js";
import { AuthRepository } from "../../app/contexts/identity/auth/auth.repository.js";

import { buildWorkspaceRouter } from "../../app/contexts/organization/workspace/workspace.route.js";
import { WorkspaceController } from "../../app/contexts/organization/workspace/workspace.controller.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";

import { errorHandler } from "../../app/middleware/error.middleware.js";
import { isAuthenticated } from "../../app/middleware/auth.middleware.js";

let testApp;
let userRepo;
let authService;
let authController;
let authRouter;

let workspaceRepo;
let roleRepo;
let roleService;
let workspaceService;
let workspaceController;
let workspaceRouter;

beforeAll(() => {
  testApp = express();
  testApp.use(express.json());
  
  process.env.INTERNAL_API_KEY = "test-internal-key";
  
  // For E2E we need to persist session across requests, but supertest doesn't store cookies automatically
  // unless we use a cookie agent. To simplify, we will mock req.user manually in a middleware for authenticated routes,
  // or we can use `supertest.agent()` which keeps cookies!
  
  testApp.use(
    session({
      secret: "test-secret",
      resave: false,
      saveUninitialized: false,
    })
  );
  testApp.use(passport.initialize());
  testApp.use(passport.session());

  // Setup Auth
  userRepo = new AuthRepository();
  authService = new AuthService({ authRepository: userRepo });
  authController = new AuthController({ authService });
  authRouter = buildAuthRouter(authController);

  // Setup Workspace
  workspaceRepo = new WorkspaceRepository();
  roleRepo = new RoleRepository();
  roleService = new RoleService({ roleRepository: roleRepo });
  workspaceService = new WorkspaceService({ 
    workspaceRepository: workspaceRepo, 
    roleService: roleService,
    userRepository: userRepo
  });
  workspaceController = new WorkspaceController({ workspaceService });
  workspaceRouter = buildWorkspaceRouter(workspaceController);

  testApp.use("/api/auth", authRouter);
  testApp.use("/api/workspaces", workspaceRouter);
  testApp.use(errorHandler);
});

describe("E2E - Project Creation Flow", () => {
  let createdUserId;
  let workspaceId;

  afterAll(async () => {
    await UserModel.deleteMany({});
    await WorkspaceModel.deleteMany({});
    await ProjectModel.deleteMany({});
  });

  it("should execute the full project creation flow successfully", async () => {
    // Step 1: User registers
    let response = await request(testApp)
      .post("/api/auth/register")
      .send({
        name: "E2E User",
        email: "e2e@example.com",
        password: "Password123!"
      });

    expect(response.status).toBe(201);
    createdUserId = response.body.user._id;

    // Step 2: User creates a workspace
    response = await request(testApp)
      .post("/api/workspaces")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", createdUserId)
      .send({
        name: "My E2E Workspace",
        url: "my-e2e-workspace",
        description: "Testing E2E flow"
      });

    if (response.status !== 201) console.log("Workspace creation failed:", response.body);
    expect(response.status).toBe(201);
    expect(response.body.workspace.name).toBe("My E2E Workspace");
    workspaceId = response.body.workspace._id;
  });
});
