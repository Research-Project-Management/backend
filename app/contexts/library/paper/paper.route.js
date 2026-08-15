import { Router } from "express";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import {
  IngestPaperDto,
  UploadPaperDto,
  UpdatePaperDto,
  AddAttachmentDto,
  ImportStoragePaperDto,
} from "./paper.dto.js";

export const buildPaperRouter = (controller) => {
  const router = Router();

  // ── Unified Academic Ingestion Seam ───────────────────────────────────────
  router.post(
    "/:workspaceId/ingest",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(IngestPaperDto),
    controller.ingestPaper
  );

  // ── RESTful Paper Endpoints (mounted at /api/library/papers) ───────────────

  // List all papers in workspace
  router.get(
    "/:workspaceId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getPapers
  );

  // Upload new paper
  router.post(
    "/:workspaceId/upload",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UploadPaperDto),
    controller.uploadPaper
  );

  // Import paper from storage file
  router.post(
    "/:workspaceId/import-storage",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(ImportStoragePaperDto),
    controller.importFromStorage
  );

  // Get paper detail
  router.get(
    "/:workspaceId/:paperId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getPaperById
  );

  // Add attachment to paper
  router.post(
    "/:workspaceId/:paperId/attachments",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(AddAttachmentDto),
    controller.addAttachment
  );

  // Remove attachment from paper
  router.delete(
    "/:workspaceId/:paperId/attachments/:attachmentId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.removeAttachment
  );

  // Reindex paper for vector AI
  router.post(
    "/:workspaceId/:paperId/reindex",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.triggerReindex
  );

  // Update paper metadata
  router.put(
    "/:workspaceId/:paperId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdatePaperDto),
    controller.updatePaper
  );

  // Delete paper
  router.delete(
    "/:workspaceId/:paperId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deletePaper
  );

  // ── Legacy alias routes (for backward compatibility) ──────────────────────
  router.get(
    "/:workspaceId/papers",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getPapers
  );

  router.post(
    "/:workspaceId/papers/upload",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UploadPaperDto),
    controller.uploadPaper
  );

  router.post(
    "/:workspaceId/papers/import-storage",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(ImportStoragePaperDto),
    controller.importFromStorage
  );

  router.get(
    "/:workspaceId/collections/:collectionId/papers",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollectionPapers
  );

  router.post(
    "/:workspaceId/collections/:collectionId/papers",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UploadPaperDto),
    controller.uploadPaperToCollection
  );

  router.post(
    "/:workspaceId/papers/:paperId/reindex",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.triggerReindex
  );

  router.post(
    "/:workspaceId/papers/:paperId/attachments",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(AddAttachmentDto),
    controller.addAttachment
  );

  router.delete(
    "/:workspaceId/papers/:paperId/attachments/:attachmentId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.removeAttachment
  );

  router.put(
    "/:workspaceId/papers/:paperId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdatePaperDto),
    controller.updatePaper
  );

  router.delete(
    "/:workspaceId/papers/:paperId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deletePaper
  );

  return router;
};
