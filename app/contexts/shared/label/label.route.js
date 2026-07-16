import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { checkLabelRole } from "../../../middleware/label.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateLabelDto, UpdateLabelDto } from "./label.dto.js";

export const buildLabelRouter = (labelController) => {
  const labelRouter = Router();
  const m = [isAuthenticated, checkWorkspaceRole("member")];
  const pw = [isAuthenticated, checkWorkspaceRole("owner", "admin", "member")];
  const pwLabel = [isAuthenticated, checkLabelRole("owner", "admin", "member")];

  // Workspace-context routes
  labelRouter.get("/workspace/:workspaceId/labels", m, labelController.getLabels);
  labelRouter.post("/workspace/:workspaceId/labels", pw, validate(CreateLabelDto), labelController.createLabel);
  labelRouter.put("/workspace/:workspaceId/labels/:labelId", pw, validate(UpdateLabelDto), labelController.updateLabel);
  labelRouter.delete("/workspace/:workspaceId/labels/:labelId", pw, labelController.deleteLabel);

  // Global-context routes (alias paths mapped from frontend queries)
  labelRouter.put("/labels/:labelId", pwLabel, validate(UpdateLabelDto), labelController.updateLabel);
  labelRouter.delete("/labels/:labelId", pwLabel, labelController.deleteLabel);

  return labelRouter;
}

