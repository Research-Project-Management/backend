import { AppError } from "../../../lib/AppError.js";
import { asyncHandler } from "../../../lib/asyncHandler.js";

export class WorkspaceController {
  constructor({ workspaceService }) {
    this.workspaceService = workspaceService;
    this.getMyWorkspaces = asyncHandler(async (req, res) => { const { workspaces, cached } = await this.workspaceService.getMyWorkspaces(req.user._id); res.json({ workspaces, cached }); });
    this.createWorkspace = asyncHandler(async (req, res) => { res.status(201).json({ workspace: await this.workspaceService.createWorkspace(req.body, req.user._id) }); });
    this.getWorkspace = asyncHandler(async (req, res) => { const workspace = await this.workspaceService.getWorkspace(req.workspace._id); if (!workspace) throw new AppError("Workspace not found", 404); res.json({ workspace, yourRole: req.workspaceRole }); });
    this.updateWorkspace = asyncHandler(async (req, res) => { res.json({ workspace: await this.workspaceService.updateWorkspace(req.workspace, req.body) }); });
    this.deleteWorkspace = asyncHandler(async (req, res) => { await this.workspaceService.deleteWorkspace(req.workspace._id, req.user._id); res.status(204).end(); });
    this.getMembers = asyncHandler(async (req, res) => { const workspace = await this.workspaceService.getWorkspace(req.workspace._id); res.json({ members: workspace.members }); });
    this.addMember = asyncHandler(async (req, res) => { res.status(201).json({ workspace: await this.workspaceService.addMember(req.workspace._id, req.body, req.user._id) }); });
    this.updateMember = asyncHandler(async (req, res) => { res.json({ workspace: await this.workspaceService.updateMember(req.workspace._id, req.params.userId || req.body.userId, req.body, req.user._id) }); });
    this.removeMember = asyncHandler(async (req, res) => { await this.workspaceService.removeMember(req.workspace, req.params.userId || req.body.userId, req.user._id); res.status(204).end(); });
    this.inviteMember = asyncHandler(async (req, res) => { res.status(201).json(await this.workspaceService.inviteMember(req.workspace, req.body, req.user._id)); });
    this.joinWorkspace = asyncHandler(async (req, res) => { res.json({ workspace: await this.workspaceService.joinWorkspace(req.body.inviteCode, req.user._id) }); });
    this.leaveWorkspace = asyncHandler(async (req, res) => { await this.workspaceService.leaveWorkspace(req.workspace, req.user._id); res.status(204).end(); });
    
    // Recent items and activities
    this.getRecentItems = asyncHandler(async (req, res) => { res.json({ items: await this.workspaceService.getRecentItems(req.workspace._id, req.user._id) }); });
    this.getActivityFeed = asyncHandler(async (req, res) => { res.json({ activities: await this.workspaceService.getActivityFeed(req.workspace._id) }); });

    this.searchWorkspace = asyncHandler(async (req, res) => {
      const results = await this.workspaceService.searchWorkspace(req.workspace._id, req.query.q || req.query.query, req.user._id, req.workspaceRole);
      res.json({ results });
    });
  }
}



