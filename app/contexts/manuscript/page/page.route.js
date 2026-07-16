import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { checkPageRole } from "../../../middleware/page.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreatePageDto, UpdatePageDto } from "./page.dto.js";

export const buildPageRouter = (pageController) => {
  const pageRouter = Router();

  pageRouter.get("/workspace/:workspaceId/pages", isAuthenticated, pageController.getWorkspacePages);
  pageRouter.get("/project/:projectId/pages", isAuthenticated, checkProjectRole("manager", "member", "viewer"), pageController.getProjectPages);
  pageRouter.post("/project/:projectId/pages", isAuthenticated, checkProjectRole("manager", "member"), validate(CreatePageDto), pageController.createPage);
  
  // Project-context page routes (using checkPageRole)
  pageRouter.get("/project/:projectId/pages/:pageId", isAuthenticated, checkPageRole("manager", "member", "viewer"), pageController.getPage);
  pageRouter.put("/project/:projectId/pages/:pageId", isAuthenticated, checkPageRole("manager", "member"), validate(UpdatePageDto), pageController.updatePage);
  pageRouter.delete("/project/:projectId/pages/:pageId", isAuthenticated, checkPageRole("manager", "member"), pageController.deletePage);
  pageRouter.post("/project/:projectId/pages/:pageId/duplicate", isAuthenticated, checkPageRole("manager", "member"), pageController.duplicatePage);
  pageRouter.put("/project/:projectId/pages/:pageId/main-file", isAuthenticated, checkPageRole("manager", "member"), pageController.setMainFile);
  pageRouter.put("/project/:projectId/pages/:pageId/thumbnail", isAuthenticated, checkPageRole("manager", "member"), pageController.updateThumbnail);
  pageRouter.post("/project/:projectId/pages/:pageId/sync-project", isAuthenticated, checkPageRole("manager", "member"), pageController.syncProject);
  
  // Legacy / Unused Assets routes (maintained for backwards-compatibility using checkPageRole)
  pageRouter.post("/project/:projectId/pages/:pageId/assets", isAuthenticated, checkPageRole("manager", "member"), pageController.uploadAsset);
  pageRouter.get("/project/:projectId/pages/:pageId/assets", isAuthenticated, checkPageRole("manager", "member", "viewer"), pageController.getAssets);
  pageRouter.delete("/project/:projectId/pages/:pageId/assets/:assetId", isAuthenticated, checkPageRole("manager", "member"), pageController.deleteAsset);
  pageRouter.get("/project/:projectId/pages/:pageId/assets/:assetId/raw", pageController.getAssetRaw);

  // Global-context page routes (alias paths mapped from frontend queries)
  pageRouter.get("/pages/:pageId", isAuthenticated, checkPageRole("manager", "member", "viewer"), pageController.getPage);
  pageRouter.put("/pages/:pageId", isAuthenticated, checkPageRole("manager", "member"), validate(UpdatePageDto), pageController.updatePage);
  pageRouter.delete("/pages/:pageId", isAuthenticated, checkPageRole("manager", "member"), pageController.deletePage);
  pageRouter.post("/pages/:pageId/duplicate", isAuthenticated, checkPageRole("manager", "member"), pageController.duplicatePage);
  pageRouter.get("/pages/:pageId/files", isAuthenticated, checkPageRole("manager", "member", "viewer"), pageController.getChildPages);
  pageRouter.post("/pages/:pageId/files", isAuthenticated, checkPageRole("manager", "member"), pageController.createChildPage);
  pageRouter.put("/pages/:pageId/main-file", isAuthenticated, checkPageRole("manager", "member"), pageController.setMainFile);
  pageRouter.put("/pages/:pageId/thumbnail", isAuthenticated, checkPageRole("manager", "member"), pageController.updateThumbnail);
  pageRouter.post("/pages/:pageId/sync-project", isAuthenticated, checkPageRole("manager", "member"), pageController.syncProject);

  return pageRouter;
}

