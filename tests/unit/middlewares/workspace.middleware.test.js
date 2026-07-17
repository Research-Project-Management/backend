import { jest } from "@jest/globals";
import { checkWorkspaceRole } from "../../../app/middleware/workspace.middleware.js";
import WorkspaceModel from "../../../app/contexts/organization/workspace/workspace.schema.js";

jest.mock("../../../app/config/cache.js", () => ({
  getOrSetCache: jest.fn(async (key, fetcher) => await fetcher()),
  deleteCache: jest.fn()
}));
describe("Workspace Middleware - checkWorkspaceRole", () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      params: { workspaceId: "workspace_id_" + Math.random().toString(36).substring(2, 9) },
      user: { _id: "user_id" },
      body: {},
      query: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it("should return 400 if no workspace identifier is provided", async () => {
    req.params = {};
    req.body = {};
    req.query = {};
    const middleware = checkWorkspaceRole("admin");
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Workspace identifier missing" });
  });

  it("should return 404 if workspace is not found", async () => {
    const mockPopulate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    jest.spyOn(WorkspaceModel, "findOne").mockReturnValue({ populate: mockPopulate });
    jest.spyOn(WorkspaceModel, "findById").mockReturnValue({ populate: mockPopulate });

    const middleware = checkWorkspaceRole("admin");
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Workspace not found" });
  });

  it("should return 403 if user is not a member of the workspace", async () => {
    const mockWorkspace = {
      members: [
        { user: "other_user_id", role: { name: "admin" } }
      ]
    };
    const mockPopulate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockWorkspace) });
    jest.spyOn(WorkspaceModel, "findOne").mockReturnValue({ populate: mockPopulate });

    const middleware = checkWorkspaceRole("admin");
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Not a member of this workspace" });
  });

  it("should return 403 if user does not have the required role", async () => {
    const mockWorkspace = {
      members: [
        { user: "user_id", role: { name: "viewer" } }
      ]
    };
    const mockPopulate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockWorkspace) });
    jest.spyOn(WorkspaceModel, "findOne").mockReturnValue({ populate: mockPopulate });

    const middleware = checkWorkspaceRole("admin"); // Requires admin
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Insufficient permissions" });
  });

  it("should call next() if user has the exact required role", async () => {
    const mockWorkspace = {
      members: [
        { user: "user_id", role: { name: "admin" } }
      ]
    };
    const mockPopulate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockWorkspace) });
    jest.spyOn(WorkspaceModel, "findOne").mockReturnValue({ populate: mockPopulate });

    const middleware = checkWorkspaceRole("admin");
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspace).toBe(mockWorkspace);
    expect(req.workspaceRole).toBe("admin");
  });

  it("should call next() if user has a higher role (owner > admin)", async () => {
    const mockWorkspace = {
      members: [
        { user: "user_id", role: { name: "owner" } }
      ]
    };
    const mockPopulate = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockWorkspace) });
    jest.spyOn(WorkspaceModel, "findOne").mockReturnValue({ populate: mockPopulate });

    const middleware = checkWorkspaceRole("admin"); // Requires admin, user is owner
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.workspace).toBe(mockWorkspace);
    expect(req.workspaceRole).toBe("owner");
  });
});
