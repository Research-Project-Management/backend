import { AppError } from '../../../lib/AppError.js';
import { asyncHandler } from '../../../lib/asyncHandler.js';

/**
 * Base Controller for file operations.
 */
export class FileController {
  constructor({ fileService }) {
    this.fileService = fileService;

    this.presign = asyncHandler(async (req, res) => {
      const filename = req.body.filename || req.body.fileName;
      const result = await this.fileService.presign({ filename });
      res.json(result);
    });

    this.uploadR2 = asyncHandler(async (req, res) => {
      if (!req.file) {
        throw new AppError('No file uploaded', 400);
      }
      const filename = req.body.filename || req.body.fileName;
      if (!filename) {
        throw new AppError('filename is required', 400);
      }

      const result = await this.fileService.uploadR2({
        filename,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
      });
      res.json(result);
    });

    this.upload = asyncHandler(async (req, res) => {
      const result = await this.fileService.upload(
        this.getScopeId(req),
        req.body,
        req.user._id,
      );
      res.status(result.overwritten ? 200 : 201).json(result);
    });

    this.createFolder = asyncHandler(async (req, res) => {
      const folder = await this.fileService.createFolder(
        this.getScopeId(req),
        req.body,
        req.user._id,
      );
      res.status(201).json({ folder });
    });

    this.getFile = asyncHandler(async (req, res) => {
      const fileRecord = await this.fileService.getFile(req.params.fileId);
      if (!fileRecord) {
        throw new AppError('File not found', 404);
      }
      res.json({ file: fileRecord });
    });

    this.updateFile = asyncHandler(async (req, res) => {
      const updatedFile = await this.fileService.updateFile(
        req.params.fileId,
        req.body,
        req.user._id,
      );
      res.json({ file: updatedFile });
    });

    this.deleteFile = asyncHandler(async (req, res) => {
      await this.fileService.deleteFile(req.params.fileId, req.user._id);
      res.status(204).end();
    });

    this.proxyR2 = asyncHandler(async (req, res) => {
      await this.fileService.proxyR2(req.params.key, res);
    });

    this.toggleStar = asyncHandler(async (req, res) => {
      const file = await this.fileService.toggleStar(req.params.fileId);
      res.json({ file });
    });

    this.restoreFile = asyncHandler(async (req, res) => {
      const file = await this.fileService.restoreFile(req.params.fileId);
      res.json({ file });
    });

    this.permanentlyDeleteFile = asyncHandler(async (req, res) => {
      await this.fileService.permanentlyDeleteFile(req.params.fileId);
      res.status(204).end();
    });

    this.shareFile = asyncHandler(async (req, res) => {
      const file = await this.fileService.shareFile(
        req.params.fileId,
        req.body,
      );
      res.json({ file });
    });

    this.renameFile = asyncHandler(async (req, res) => {
      const file = await this.fileService.renameFile(
        req.params.fileId,
        req.body.name,
      );
      res.json({ file });
    });

    this.moveFile = asyncHandler(async (req, res) => {
      const file = await this.fileService.moveFile(
        req.params.fileId,
        req.body.parentId,
      );
      res.json({ file });
    });

    this.updateMetadata = asyncHandler(async (req, res) => {
      const file = await this.fileService.updateMetadata(
        req.params.fileId,
        req.body,
      );
      res.json({ file });
    });

    this.getHomeFiles = asyncHandler(async (req, res) => {
      const files = await this.fileService.getFiles(this.getScopeId(req), {
        parentId: null,
      });
      res.json({ files });
    });

    this.getFiles = asyncHandler(async (req, res) => {
      const filters = {};
      if (req.query.parentId !== undefined) {
        filters.parentId = req.query.parentId === 'null' ? null : req.query.parentId;
      }
      const files = await this.fileService.getFiles(this.getScopeId(req), filters);
      res.json({ files });
    });

    this.getMyFiles = asyncHandler(async (req, res) => {
      const files = await this.fileService.getFiles(this.getScopeId(req), {
        authorId: req.user._id,
      });
      res.json({ files });
    });

    this.getStarredFiles = asyncHandler(async (req, res) => {
      const files = await this.fileService.getFiles(this.getScopeId(req), {
        starred: true,
      });
      res.json({ files });
    });

    this.getSharedFiles = asyncHandler(async (req, res) => {
      const files = await this.fileService.getFiles(this.getScopeId(req), {
        sharedWithUserId: req.user._id,
      });
      res.json({ files });
    });

    this.getTrashedFiles = asyncHandler(async (req, res) => {
      const files = await this.fileService.getFiles(this.getScopeId(req), {
        isTrashed: true,
      });
      res.json({ files });
    });
  }

  /**
   * Abstract param getter meant to be overridden by child classes.
   */
  getScopeId(req) {
    return null;
  }
}

export class WorkspaceFileController extends FileController {
  constructor({ workspaceFileService }) {
    super({ fileService: workspaceFileService });

    // Override getHomeFiles to aggregate workspace + all project files
    this.getHomeFiles = asyncHandler(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      const rawParentId = req.query.parentId;

      // Navigating inside a subfolder — show that folder's contents directly
      if (rawParentId && rawParentId !== 'null') {
        const files = await this.fileService.getFiles(workspaceId, {
          parentId: rawParentId,
        });
        return res.json({ files });
      }

      // Root view — aggregate workspace-level + all project files
      const filters = {};
      if (req.query.projectId) filters.projectId = req.query.projectId;
      
      if (rawParentId === 'null') {
        filters.parentId = null;
      }

      const files = await this.fileService.getHomeFiles(workspaceId, filters);
      res.json({ files });
    });
  }

  getScopeId(req) {
    return req.params.workspaceId;
  }
}

export class ProjectFileController extends FileController {
  constructor({ projectFileService }) {
    super({ fileService: projectFileService });
  }

  getScopeId(req) {
    return req.params.projectId;
  }
}

export class PageFileController extends FileController {
  constructor({ pageFileService }) {
    super({ fileService: pageFileService });
  }

  getScopeId(req) {
    return req.params.pageId;
  }
}
