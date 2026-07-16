import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateStickyDto, UpdateStickyDto, ReorderStickiesDto, AddChildStickyDto } from "./sticky.dto.js";

export const buildStickyRouter = (stickyController) => {
  const stickyRouter = Router();
  const m = [isAuthenticated, checkWorkspaceRole("member")];
  const pw = [isAuthenticated, checkProjectRole("manager", "member", "viewer")];

stickyRouter.get("/workspace/:workspaceId/stickies", m, stickyController.getWorkspaceStickies);
stickyRouter.post("/workspace/:workspaceId/stickies", m, validate(CreateStickyDto), stickyController.createSticky);
stickyRouter.put("/workspace/:workspaceId/stickies/reorder", m, validate(ReorderStickiesDto), stickyController.reorderWorkspaceStickies);
stickyRouter.get("/project/:projectId/stickies", pw, stickyController.getProjectStickies);
stickyRouter.put("/project/:projectId/stickies/reorder", pw, validate(ReorderStickiesDto), stickyController.reorderProjectStickies);
stickyRouter.put("/stickies/:stickyId", isAuthenticated, validate(UpdateStickyDto), stickyController.updateSticky);
stickyRouter.delete("/stickies/:stickyId", isAuthenticated, stickyController.deleteSticky);
stickyRouter.get("/stickies/:stickyId/children", isAuthenticated, stickyController.getChildren);
stickyRouter.post("/stickies/:stickyId/children", isAuthenticated, validate(AddChildStickyDto), stickyController.addChild);
stickyRouter.delete("/stickies/:stickyId/children/:childStickyId", isAuthenticated, stickyController.removeChild);

  return stickyRouter;
}
