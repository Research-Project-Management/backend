import { asyncHandler } from "../../../lib/asyncHandler.js";

export class StickyController {
  constructor({ stickyService }) {
    this.stickyService = stickyService;
    this.getWorkspaceStickies = asyncHandler(async (req, res) => { res.json({ stickies: await this.stickyService.getWorkspaceStickies(req.workspace._id, req.user._id, req.query) }); });
    this.createSticky = asyncHandler(async (req, res) => { 
      const workspaceId = req.workspace ? req.workspace._id : req.project.workspace;
      const projectId = req.project ? req.project._id : req.body.projectId;
      const body = { ...req.body, projectId };
      res.status(201).json({ sticky: await this.stickyService.createSticky(workspaceId, body, req.user._id) }); 
    });
    this.reorderWorkspaceStickies = asyncHandler(async (req, res) => { await this.stickyService.reorder(req.body.stickyIds, req.user._id, "workspace", req.workspace._id); res.json({ message: "Reordered successfully" }); });
    this.getProjectStickies = asyncHandler(async (req, res) => { res.json({ stickies: await this.stickyService.getProjectStickies(req.project._id, req.user._id, req.query) }); });
    this.reorderProjectStickies = asyncHandler(async (req, res) => { await this.stickyService.reorder(req.body.stickyIds, req.user._id, "project", req.project._id); res.json({ message: "Reordered successfully" }); });
    this.updateSticky = asyncHandler(async (req, res) => { res.json({ sticky: await this.stickyService.updateSticky(req.params.stickyId, req.body, req.user._id) }); });
    this.deleteSticky = asyncHandler(async (req, res) => { await this.stickyService.deleteSticky(req.params.stickyId, req.user._id); res.status(204).end(); });
    this.getChildren = asyncHandler(async (req, res) => { res.json({ children: await this.stickyService.getChildren(req.params.stickyId, req.user._id) }); });
    this.addChild = asyncHandler(async (req, res) => { res.status(201).json(await this.stickyService.addChild(req.params.stickyId, req.body, req.user._id)); });
    this.removeChild = asyncHandler(async (req, res) => { await this.stickyService.removeChild(req.params.stickyId, req.params.childStickyId, req.user._id); res.status(204).end(); });
  }
}



