import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateStickyDto, UpdateStickyDto, ReorderStickiesDto } from "./sticky.dto.js";

export const buildStickyRouter = (stickyController, workspaceStickyController, projectStickyController) => {
  const stickyRouter = Router();
  const m = [isAuthenticated, checkWorkspaceRole("member")];
  const pw = [isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer")];

  stickyRouter.get("/workspace/:workspaceId/stickies", m, workspaceStickyController.getStickies);
  stickyRouter.post("/workspace/:workspaceId/stickies", m, validate(CreateStickyDto), workspaceStickyController.createSticky);
  stickyRouter.put("/workspace/:workspaceId/stickies/reorder", m, validate(ReorderStickiesDto), workspaceStickyController.reorderStickies);
  
  stickyRouter.get("/project/:projectId/stickies", pw, projectStickyController.getStickies);
  stickyRouter.post("/project/:projectId/stickies", pw, validate(CreateStickyDto), projectStickyController.createSticky);
  stickyRouter.put("/project/:projectId/stickies/reorder", pw, validate(ReorderStickiesDto), projectStickyController.reorderStickies);
  
  stickyRouter.put("/stickies/:stickyId", isAuthenticated, validate(UpdateStickyDto), stickyController.updateSticky);
  stickyRouter.delete("/stickies/:stickyId", isAuthenticated, stickyController.deleteSticky);

  return stickyRouter;
}
