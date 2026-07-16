import { Router } from "express";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { UploadPaperDto, UpdatePaperDto } from "./paper.dto.js";

export const buildPaperRouter = (container) => {
  const paperRouter = Router();
  const controller = container.resolve("paperController");

  paperRouter.get(
    "/:workspaceId/papers",
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getPapers
  );

  paperRouter.post(
    "/:workspaceId/papers/upload",
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UploadPaperDto),
    controller.uploadPaper
  );

  paperRouter.post(
    "/:workspaceId/papers/:paperId/reindex",
    checkWorkspaceRole("owner", "admin", "member"),
    controller.triggerReindex
  );

  paperRouter.put(
    "/:workspaceId/papers/:paperId",
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdatePaperDto),
    controller.updatePaper
  );

  paperRouter.delete(
    "/:workspaceId/papers/:paperId",
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deletePaper
  );

  return paperRouter;
};

