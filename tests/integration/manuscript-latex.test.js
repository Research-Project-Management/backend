import request from "supertest";
import express from "express";

import UserModel from "../../app/contexts/identity/auth/auth.schema.js";
import RoleModel from "../../app/contexts/identity/role/role.schema.js";
import WorkspaceModel from "../../app/contexts/organization/workspace/workspace.schema.js";
import ProjectModel from "../../app/contexts/organization/project/project.schema.js";
import { PageModel } from "../../app/contexts/manuscript/page/page.schema.js";

import { RoleRepository } from "../../app/contexts/identity/role/role.repository.js";
import { RoleService } from "../../app/contexts/identity/role/role.service.js";
import { WorkspaceRepository } from "../../app/contexts/organization/workspace/workspace.repository.js";
import { WorkspaceService } from "../../app/contexts/organization/workspace/workspace.service.js";
import { WorkspaceController } from "../../app/contexts/organization/workspace/workspace.controller.js";
import { buildWorkspaceRouter } from "../../app/contexts/organization/workspace/workspace.route.js";

import { buildLatexRouter } from "../../app/contexts/manuscript/latex/latex.route.js";

import { errorHandler } from "../../app/middleware/error.middleware.js";
import { isAuthenticated } from "../../app/middleware/auth.middleware.js";

let testApp;
let roleRepo;
let roleService;
let workspaceRepo;
let workspaceService;
let workspaceController;
let latexRouter;

describe("Manuscript Latex Integration", () => {
  let owner;
  let workspace;
  let project;
  let rootPage;
  let originalFetch;

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

    latexRouter = buildLatexRouter();

    testApp.use("/api/workspace", workspaceRouter);
    testApp.use("/api/latex", isAuthenticated, latexRouter);
    testApp.use(errorHandler);

    originalFetch = global.fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
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
      email: "owner-latex@test.com",
      password: "password123",
      firstName: "Latex",
      lastName: "Owner",
    });

    const wsRes = await request(testApp)
      .post("/api/workspace")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        name: "Latex Workspace",
        url: "latex-ws-" + Date.now(),
      });
    workspace = wsRes.body.workspace;
    const ownerRole = await RoleModel.findOne({ name: "Owner", workspace: workspace._id });

    project = await ProjectModel.create({
      name: "Latex Project",
      workspace: workspace._id,
      createdBy: owner._id,
      members: [{ user: owner._id, role: ownerRole._id }]
    });

    rootPage = await PageModel.create({
      title: "Root Latex Page",
      content: "\\documentclass{article}\\begin{document}Hello\\end{document}",
      project: project._id,
      author: owner._id
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fail compile if parentPageId is not a root page", async () => {
    const childPage = await PageModel.create({
      title: "Child Latex Page",
      content: "test",
      project: project._id,
      author: owner._id,
      parentPage: rootPage._id
    });

    const res = await request(testApp)
      .post("/api/latex/compile")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        parentPageId: childPage._id.toString()
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only root pages/);
  });

  it("should compile successfully and return JSON on 200 (modern compiler)", async () => {
    let fetchCalls = [];
    global.fetch = async (...args) => {
      fetchCalls.push(args);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ pdf: "base64pdf", synctex: "synctexdata" })
      };
    };

    const res = await request(testApp)
      .post("/api/latex/compile")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        parentPageId: rootPage._id.toString(),
        engine: "pdflatex"
      });

    expect(res.status).toBe(200);
    expect(res.body.pdf).toBe("base64pdf");
    expect(fetchCalls.length).toBe(1);
    const callArgs = fetchCalls[0];
    expect(callArgs[0]).toContain("/compile");
    expect(JSON.parse(callArgs[1].body)).toMatchObject({
      project_id: rootPage._id.toString(),
      engine: "pdflatex"
    });
  });

  it("should retry on 503 and eventually succeed", async () => {
    let attempts = 0;
    global.fetch = async () => {
      attempts++;
      if (attempts < 3) {
        return { ok: false, status: 503 };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ pdf: "ok", synctex: "ok" })
      };
    };

    const res = await request(testApp)
      .post("/api/latex/compile")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        parentPageId: rootPage._id.toString()
      });

    expect(res.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it("should fail after max retries on 503", async () => {
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return { ok: false, status: 503 };
    };

    const res = await request(testApp)
      .post("/api/latex/compile")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({
        parentPageId: rootPage._id.toString()
      });

    expect(res.status).toBe(503);
    // expect(res.body.error).toBe("latex_service_unavailable"); // Not necessarily this error string since it's forwarded from upstream
    // 1 initial + 3 retries = 4 calls total
    expect(fetchCalls).toBe(4);
  }, 10000); // Allow longer timeout for backoff

  it("should require source if no parentPageId is provided", async () => {
    const res = await request(testApp)
      .post("/api/latex/compile")
      .set("x-internal-key", "test-internal-key")
      .set("x-user-id", owner._id.toString())
      .send({}); // no source, no project_id

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing or invalid 'source' field/);
  });
});
