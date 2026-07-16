import { AppError } from "../../../lib/AppError.js";
import { asyncHandler } from "../../../lib/asyncHandler.js";

export class FileController {
  constructor({ fileService }) {
    this.fileService = fileService;
    this.presign = asyncHandler(async (req, res) => { res.json(await this.fileService.presign(req.body)); });
    this.upload = asyncHandler(async (req, res) => { const result = await this.fileService.upload(req.body, req.user._id); res.status(result.overwritten ? 200 : 201).json(result); });
    this.createFolder = asyncHandler(async (req, res) => { res.status(201).json({ folder: await this.fileService.createFolder(req.body, req.user._id) }); });
    this.getProjectFiles = asyncHandler(async (req, res) => { res.json({ files: await this.fileService.getProjectFiles(req.params.projectId, req.query) }); });
    this.getWorkspaceFiles = asyncHandler(async (req, res) => { res.json({ files: await this.fileService.getWorkspaceFiles(req.params.workspaceId, req.query) }); });
    this.getPageFiles = asyncHandler(async (req, res) => { res.json({ files: await this.fileService.getPageFiles(req.params.pageId, req.query) }); });
    this.getFile = asyncHandler(async (req, res) => { const f = await this.fileService.getFile(req.params.fileId); if (!f) throw new AppError("File not found", 404); res.json({ file: f }); });
    this.updateFile = asyncHandler(async (req, res) => { res.json({ file: await this.fileService.updateFile(req.params.fileId, req.body, req.user._id) }); });
    this.deleteFile = asyncHandler(async (req, res) => { await this.fileService.deleteFile(req.params.fileId, req.user._id); res.status(204).end(); });
    this.proxyR2 = async (req, res) => { await this.fileService.proxyR2(req.params.key, res); };

    // Advanced storage query actions
    this.getWorkspaceHome = asyncHandler(async (req, res) => { res.json(await this.fileService.getWorkspaceHome(req.params.workspaceId, req.user._id)); });
    this.getWorkspaceAllFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getWorkspaceAllFiles(req.params.workspaceId, req.query.parentId)); });
    this.getWorkspaceMyFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getWorkspaceMyFiles(req.params.workspaceId, req.user._id)); });
    this.getWorkspaceStarredFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getWorkspaceStarredFiles(req.params.workspaceId)); });
    this.getWorkspaceSharedFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getWorkspaceSharedFiles(req.params.workspaceId, req.user._id)); });
    this.getWorkspaceTrashedFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getWorkspaceTrashedFiles(req.params.workspaceId)); });

    this.getProjectMyFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getProjectMyFiles(req.params.projectId, req.user._id)); });
    this.getProjectStarredFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getProjectStarredFiles(req.params.projectId)); });
    this.getProjectSharedFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getProjectSharedFiles(req.params.projectId, req.user._id)); });
    this.getProjectTrashedFiles = asyncHandler(async (req, res) => { res.json(await this.fileService.getProjectTrashedFiles(req.params.projectId)); });

    // File mutation actions
    this.toggleStar = asyncHandler(async (req, res) => { res.json({ file: await this.fileService.toggleStar(req.params.fileId) }); });
    this.restoreFile = asyncHandler(async (req, res) => { res.json({ file: await this.fileService.restoreFile(req.params.fileId) }); });
    this.permanentlyDeleteFile = asyncHandler(async (req, res) => { await this.fileService.permanentlyDeleteFile(req.params.fileId); res.status(204).end(); });
    this.shareFile = asyncHandler(async (req, res) => { res.json({ file: await this.fileService.shareFile(req.params.fileId, req.body) }); });
    this.renameFile = asyncHandler(async (req, res) => { res.json({ file: await this.fileService.renameFile(req.params.fileId, req.body.name) }); });
    this.moveFile = asyncHandler(async (req, res) => { res.json({ file: await this.fileService.moveFile(req.params.fileId, req.body.parentId) }); });
    this.updateMetadata = asyncHandler(async (req, res) => { res.json({ file: await this.fileService.updateMetadata(req.params.fileId, req.body.metaData) }); });

    // Crossref
    this.crossrefSearch = asyncHandler(async (req, res) => { res.json(await this.fileService.crossrefSearch(req.query.query, req.query.rows)); });
    this.crossrefDoi = asyncHandler(async (req, res) => { res.json(await this.fileService.crossrefDoi(req.params[0])); });
  }
}




