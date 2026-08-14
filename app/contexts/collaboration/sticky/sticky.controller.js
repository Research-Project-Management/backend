import { asyncHandler } from "../../../lib/asyncHandler.js";

export class StickyController {
  constructor({ stickyService }) {
    this.stickyService = stickyService;
  }

  getScopeContext(req) {
    throw new Error("getScopeContext must be implemented by subclass");
  }

  getStickies = asyncHandler(async (req, res) => {
    const { _id: userId } = req.user;
    const scopeContext = this.getScopeContext(req);
    const query = req.query;

    const stickies = await this.stickyService.getStickies(scopeContext, userId, query);
    res.json({ stickies });
  });

  createSticky = asyncHandler(async (req, res) => {
    const { _id: userId } = req.user;
    const body = req.body;
    const scopeContext = this.getScopeContext(req);

    const sticky = await this.stickyService.createSticky(scopeContext, body, userId);
    res.status(201).json({ sticky });
  });

  reorderStickies = asyncHandler(async (req, res) => {
    const { stickyIds } = req.body;
    const { _id: userId } = req.user;
    const scopeContext = this.getScopeContext(req);

    await this.stickyService.reorder(stickyIds, userId, scopeContext);
    res.json({ message: "Reordered successfully" });
  });

  updateSticky = asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const body = req.body;
    const { _id: userId } = req.user;

    const sticky = await this.stickyService.updateSticky(stickyId, body, userId);
    res.json({ sticky });
  });

  deleteSticky = asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const { _id: userId } = req.user;

    await this.stickyService.deleteSticky(stickyId, userId);
    res.status(204).end();
  });
}

export class WorkspaceStickyController extends StickyController {
  constructor({ workspaceStickyService }) {
    super({ stickyService: workspaceStickyService });
  }

  getScopeContext(req) {
    return { workspaceId: req.workspace._id };
  }
}

export class ProjectStickyController extends StickyController {
  constructor({ projectStickyService }) {
    super({ stickyService: projectStickyService });
  }

  getScopeContext(req) {
    return { 
      projectId: req.project._id, 
      workspaceId: req.project.workspaceId 
    };
  }
}
