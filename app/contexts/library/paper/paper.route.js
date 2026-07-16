import { Router } from "express";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { UploadPaperDto, UpdatePaperDto } from "./paper.dto.js";

export const buildPaperRouter = (controller) => {
  const paperRouter = Router();

  paperRouter.get(
    "/:workspaceId/papers",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getPapers
  );

  paperRouter.post(
    "/:workspaceId/papers/upload",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UploadPaperDto),
    controller.uploadPaper
  );

  paperRouter.get(
    "/:workspaceId/collections/:collectionId/papers",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollectionPapers
  );

  paperRouter.post(
    "/:workspaceId/collections/:collectionId/papers",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UploadPaperDto),
    controller.uploadPaperToCollection
  );


  paperRouter.post(
    "/:workspaceId/papers/:paperId/reindex",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.triggerReindex
  );

  paperRouter.put(
    "/:workspaceId/papers/:paperId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdatePaperDto),
    controller.updatePaper
  );

  paperRouter.delete(
    "/:workspaceId/papers/:paperId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deletePaper
  );

  return paperRouter;
};

