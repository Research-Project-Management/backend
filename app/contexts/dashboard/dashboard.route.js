import { Router } from "express";
import { isAuthenticated } from "../../middleware/auth.middleware.js";
import { mapWorkspaceId, checkWorkspaceRole } from "../../middleware/workspace.middleware.js";
import { checkProjectRole } from "../../middleware/project.middleware.js";

export const buildDashboardRouter = (dashboardController) => {
  const dashboardRouter = Router();

  // Workspace-level dashboard routes
  dashboardRouter.get(
    "/workspaces/:workspaceId/search",
    isAuthenticated,
    mapWorkspaceId,
    checkWorkspaceRole("viewer"),
    dashboardController.globalSearch
  );

  dashboardRouter.get(
    "/workspaces/:workspaceId/recent",
    isAuthenticated,
    mapWorkspaceId,
    checkWorkspaceRole("viewer"),
    dashboardController.getRecentItems
  );

  dashboardRouter.get(
    "/workspaces/:workspaceId/activity",
    isAuthenticated,
    mapWorkspaceId,
    checkWorkspaceRole("viewer"),
    dashboardController.getActivityFeed
  );

  // Project-level dashboard routes
  dashboardRouter.get(
    "/projects/:projectId/overview",
    isAuthenticated,
    checkProjectRole("viewer"),
    dashboardController.getProjectOverview
  );

  return dashboardRouter;
};
