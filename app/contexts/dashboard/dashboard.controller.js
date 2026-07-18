import { asyncHandler } from "../../lib/asyncHandler.js";

export class DashboardController {
  constructor({ dashboardService }) {
    this.dashboardService = dashboardService;
  }

  globalSearch = asyncHandler(async (req, res) => {
    const workspaceId = req.workspace._id;
    const { q } = req.query;
    const userId = req.user._id.toString();
    const userRoleName = req.workspaceRole;
    
    const results = await this.dashboardService.globalSearch(workspaceId, q || "", userId, userRoleName);
    res.json(results);
  });

  getRecentItems = asyncHandler(async (req, res) => {
    const workspaceId = req.workspace._id;
    const userId = req.user._id.toString();
    const recent = await this.dashboardService.getRecentItems(workspaceId, userId);
    res.json(recent);
  });

  getActivityFeed = asyncHandler(async (req, res) => {
    const workspaceId = req.workspace._id;
    const feed = await this.dashboardService.getActivityFeed(workspaceId);
    res.json(feed);
  });

  getProjectOverview = asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    const userId = req.user._id.toString();
    const overview = await this.dashboardService.getProjectOverview(projectId, userId);
    res.json(overview);
  });
}
