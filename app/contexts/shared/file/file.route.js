import { Router } from "express";
import multer from "multer";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { PresignDto, UploadFileDto, CreateFolderDto, UpdateFileDto } from "./file.dto.js";

const upload = multer({ storage: multer.memoryStorage() });

export const buildFileRouter = (fileController) => {
  const fileRouter = Router();

  // Basic uploading & folders
  fileRouter.post("/presign", isAuthenticated, validate(PresignDto), fileController.presign);
  fileRouter.post("/upload-r2", isAuthenticated, upload.single("file"), fileController.uploadR2);
  fileRouter.post("/upload", isAuthenticated, validate(UploadFileDto), fileController.upload);
  fileRouter.post("/folder", isAuthenticated, validate(CreateFolderDto), fileController.createFolder);

  // Workspace storage scopes
  fileRouter.get("/workspace/:workspaceId/home", isAuthenticated, checkWorkspaceRole("member"), fileController.getWorkspaceHome);
  fileRouter.get("/workspace/:workspaceId/all", isAuthenticated, checkWorkspaceRole("member"), fileController.getWorkspaceAllFiles);
  fileRouter.get("/workspace/:workspaceId/my-files", isAuthenticated, checkWorkspaceRole("member"), fileController.getWorkspaceMyFiles);
  fileRouter.get("/workspace/:workspaceId/starred", isAuthenticated, checkWorkspaceRole("member"), fileController.getWorkspaceStarredFiles);
  fileRouter.get("/workspace/:workspaceId/shared", isAuthenticated, checkWorkspaceRole("member"), fileController.getWorkspaceSharedFiles);
  fileRouter.get("/workspace/:workspaceId/trash", isAuthenticated, checkWorkspaceRole("member"), fileController.getWorkspaceTrashedFiles);
  fileRouter.get("/workspace/:workspaceId", isAuthenticated, checkWorkspaceRole("member"), fileController.getWorkspaceFiles);

  // Project storage scopes
  fileRouter.get("/project/:projectId", isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer"), fileController.getProjectFiles);
  fileRouter.get("/my-files/:projectId", isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer"), fileController.getProjectMyFiles);
  fileRouter.get("/starred/:projectId", isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer"), fileController.getProjectStarredFiles);
  fileRouter.get("/shared/:projectId", isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer"), fileController.getProjectSharedFiles);
  fileRouter.get("/trash/:projectId", isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer"), fileController.getProjectTrashedFiles);

  // Page storage scope (used by LaTeX compiler sync)
  fileRouter.get("/page/:pageId", isAuthenticated, fileController.getPageFiles);

  // Crossref API
  fileRouter.get("/crossref/search", isAuthenticated, fileController.crossrefSearch);
  fileRouter.get(/^\/crossref\/doi\/(.+)/, isAuthenticated, fileController.crossrefDoi);

  // R2 assets proxy
  fileRouter.get(/^\/r2\/(.+)/, (req, res, next) => {
    req.params.key = req.params[0];
    next();
  }, fileController.proxyR2);

  // Legacy proxy for URLs without /r2/ (e.g. avatars)
  fileRouter.get(/^\/(workspace\/.+|project\/.+|avatars\/.+|avat\..+)/, (req, res, next) => {
    req.params.key = req.params[0];
    next();
  }, fileController.proxyR2);

  // File mutations & detail routes
  fileRouter.get("/:fileId", isAuthenticated, fileController.getFile);
  fileRouter.put("/:fileId", isAuthenticated, validate(UpdateFileDto), fileController.updateFile);
  fileRouter.delete("/:fileId", isAuthenticated, fileController.deleteFile); // Trashes file
  fileRouter.put("/:fileId/star", isAuthenticated, fileController.toggleStar);
  fileRouter.put("/:fileId/restore", isAuthenticated, fileController.restoreFile);
  fileRouter.delete("/:fileId/permanent", isAuthenticated, fileController.permanentlyDeleteFile);
  fileRouter.put("/:fileId/share", isAuthenticated, fileController.shareFile);
  fileRouter.put("/:fileId/rename", isAuthenticated, fileController.renameFile);
  fileRouter.put("/:fileId/move", isAuthenticated, fileController.moveFile);
  fileRouter.put("/:fileId/metadata", isAuthenticated, fileController.updateMetadata);

  return fileRouter;
}
