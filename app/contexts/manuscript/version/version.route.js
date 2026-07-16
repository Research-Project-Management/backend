import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { checkPageRole } from "../../../middleware/page.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateVersionDto } from "./version.dto.js";

export const buildVersionRouter = (versionController) => {
  const versionRouter = Router();

  // Project-context page version routes
  versionRouter.get("/project/:projectId/pages/:pageId/versions", isAuthenticated, checkProjectRole("manager", "member", "viewer"), versionController.getVersions);
  versionRouter.post("/project/:projectId/pages/:pageId/versions", isAuthenticated, checkProjectRole("manager", "member"), validate(CreateVersionDto), versionController.createVersion);
  versionRouter.post("/project/:projectId/pages/:pageId/versions/:versionId/restore", isAuthenticated, checkProjectRole("manager", "member"), versionController.restoreVersion);
  versionRouter.delete("/project/:projectId/pages/:pageId/versions/:versionId", isAuthenticated, checkProjectRole("manager", "member"), versionController.deleteVersion);
  versionRouter.get("/project/:projectId/pages/:pageId/history", isAuthenticated, checkProjectRole("manager", "member", "viewer"), versionController.getHistory);
  versionRouter.post("/project/:projectId/pages/:pageId/history/:eventId/restore", isAuthenticated, checkProjectRole("manager", "member"), versionController.restoreHistory);

  // Global-context page version routes (alias paths mapped from frontend queries)
  versionRouter.get("/pages/:pageId/versions", isAuthenticated, checkPageRole("manager", "member", "viewer"), versionController.getVersions);
  versionRouter.post("/pages/:pageId/versions", isAuthenticated, checkPageRole("manager", "member"), validate(CreateVersionDto), versionController.createVersion);
  versionRouter.post("/pages/:pageId/versions/:versionId/restore", isAuthenticated, checkPageRole("manager", "member"), versionController.restoreVersion);
  versionRouter.delete("/pages/:pageId/versions/:versionId", isAuthenticated, checkPageRole("manager", "member"), versionController.deleteVersion);
  versionRouter.get("/pages/:pageId/history", isAuthenticated, checkPageRole("manager", "member", "viewer"), versionController.getHistory);
  versionRouter.post("/pages/:pageId/history/:eventId/restore", isAuthenticated, checkPageRole("manager", "member"), versionController.restoreHistory);

  return versionRouter;
}

