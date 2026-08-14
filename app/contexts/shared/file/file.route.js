import { Router } from 'express';
import multer from 'multer';
import { isAuthenticated } from '../../../middleware/auth.middleware.js';
import { checkWorkspaceRole } from '../../../middleware/workspace.middleware.js';
import { checkProjectRole } from '../../../middleware/project.middleware.js';
import { validate } from '../../../middleware/validate.middleware.js';
import {
  PresignDto,
  UploadFileDto,
  CreateFolderDto,
  UpdateFileDto,
} from './file.dto.js';

const upload = multer({ storage: multer.memoryStorage() });

export const buildFileRouter = (
  fileController,
  workspaceFileController,
  projectFileController,
  pageFileController,
) => {
  const fileRouter = Router();

  fileRouter.post(
    '/presign',
    isAuthenticated,
    validate(PresignDto),
    fileController.presign,
  );

  fileRouter.post(
    '/workspace/:workspaceId/upload-r2',
    isAuthenticated,
    upload.single('file'),
    workspaceFileController.uploadR2,
  );
  fileRouter.post(
    '/workspace/:workspaceId/upload',
    isAuthenticated,
    validate(UploadFileDto),
    workspaceFileController.upload,
  );
  fileRouter.post(
    '/workspace/:workspaceId/folder',
    isAuthenticated,
    validate(CreateFolderDto),
    workspaceFileController.createFolder,
  );
  fileRouter.get(
    '/workspace/:workspaceId/home',
    isAuthenticated,
    checkWorkspaceRole('member'),
    workspaceFileController.getHomeFiles,
  );
  fileRouter.get(
    '/workspace/:workspaceId/all',
    isAuthenticated,
    checkWorkspaceRole('member'),
    workspaceFileController.getFiles,
  );
  fileRouter.get(
    '/workspace/:workspaceId/my-files',
    isAuthenticated,
    checkWorkspaceRole('member'),
    workspaceFileController.getMyFiles,
  );
  fileRouter.get(
    '/workspace/:workspaceId/starred',
    isAuthenticated,
    checkWorkspaceRole('member'),
    workspaceFileController.getStarredFiles,
  );
  fileRouter.get(
    '/workspace/:workspaceId/shared',
    isAuthenticated,
    checkWorkspaceRole('member'),
    workspaceFileController.getSharedFiles,
  );
  fileRouter.get(
    '/workspace/:workspaceId/trash',
    isAuthenticated,
    checkWorkspaceRole('member'),
    workspaceFileController.getTrashedFiles,
  );
  fileRouter.get(
    '/workspace/:workspaceId',
    isAuthenticated,
    checkWorkspaceRole('member'),
    workspaceFileController.getHomeFiles,
  );

  fileRouter.post(
    '/project/:projectId/upload-r2',
    isAuthenticated,
    upload.single('file'),
    projectFileController.uploadR2,
  );
  fileRouter.post(
    '/project/:projectId/upload',
    isAuthenticated,
    validate(UploadFileDto),
    projectFileController.upload,
  );
  fileRouter.post(
    '/project/:projectId/folder',
    isAuthenticated,
    validate(CreateFolderDto),
    projectFileController.createFolder,
  );
  fileRouter.get(
    '/project/:projectId/my-files',
    isAuthenticated,
    checkProjectRole('owner', 'admin', 'member', 'viewer'),
    projectFileController.getMyFiles,
  );
  fileRouter.get(
    '/project/:projectId/starred',
    isAuthenticated,
    checkProjectRole('owner', 'admin', 'member', 'viewer'),
    projectFileController.getStarredFiles,
  );
  fileRouter.get(
    '/project/:projectId/shared',
    isAuthenticated,
    checkProjectRole('owner', 'admin', 'member', 'viewer'),
    projectFileController.getSharedFiles,
  );
  fileRouter.get(
    '/project/:projectId/trash',
    isAuthenticated,
    checkProjectRole('owner', 'admin', 'member', 'viewer'),
    projectFileController.getTrashedFiles,
  );
  fileRouter.get(
    '/project/:projectId',
    isAuthenticated,
    checkProjectRole('owner', 'admin', 'member', 'viewer'),
    projectFileController.getFiles,
  );

  fileRouter.post(
    '/page/:pageId/upload-r2',
    isAuthenticated,
    upload.single('file'),
    pageFileController.uploadR2,
  );
  fileRouter.post(
    '/page/:pageId/upload',
    isAuthenticated,
    validate(UploadFileDto),
    pageFileController.upload,
  );
  fileRouter.post(
    '/page/:pageId/folder',
    isAuthenticated,
    validate(CreateFolderDto),
    pageFileController.createFolder,
  );
  fileRouter.get('/page/:pageId', isAuthenticated, pageFileController.getFiles);

  fileRouter.post(
    '/upload-r2',
    isAuthenticated,
    upload.single('file'),
    fileController.uploadR2,
  );
  fileRouter.post(
    '/upload',
    isAuthenticated,
    validate(UploadFileDto),
    fileController.upload,
  );
  fileRouter.post(
    '/folder',
    isAuthenticated,
    validate(CreateFolderDto),
    fileController.createFolder,
  );

  fileRouter.get(
    /^\/r2\/(.+)/,
    (req, res, next) => {
      req.params.key = req.params[0];
      next();
    },
    fileController.proxyR2,
  );

  fileRouter.get(
    /^\/(workspace\/.+|project\/.+|avatars\/.+|avat\..+)/,
    (req, res, next) => {
      req.params.key = req.params[0];
      next();
    },
    fileController.proxyR2,
  );

  fileRouter.get('/:fileId', isAuthenticated, fileController.getFile);
  fileRouter.put(
    '/:fileId',
    isAuthenticated,
    validate(UpdateFileDto),
    fileController.updateFile,
  );
  fileRouter.delete('/:fileId', isAuthenticated, fileController.deleteFile);
  fileRouter.put('/:fileId/star', isAuthenticated, fileController.toggleStar);
  fileRouter.put(
    '/:fileId/restore',
    isAuthenticated,
    fileController.restoreFile,
  );
  fileRouter.delete(
    '/:fileId/permanent',
    isAuthenticated,
    fileController.permanentlyDeleteFile,
  );
  fileRouter.put('/:fileId/share', isAuthenticated, fileController.shareFile);
  fileRouter.put('/:fileId/rename', isAuthenticated, fileController.renameFile);
  fileRouter.put('/:fileId/move', isAuthenticated, fileController.moveFile);
  fileRouter.put(
    '/:fileId/metadata',
    isAuthenticated,
    fileController.updateMetadata,
  );

  return fileRouter;
};
