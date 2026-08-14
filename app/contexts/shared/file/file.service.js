import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { eventBus, Events } from '../../../lib/eventBus.js';
import { AppError } from '../../../lib/AppError.js';

const ALLOWED_UPLOAD_PREFIXES = [/^workspace\//, /^project\//, /^page\//];

/**
 * Base FileService for handling file business logic.
 */
export class FileService {
  constructor({ fileRepository, r2 }) {
    this.repo = fileRepository;
    this.r2 = r2;
  }

  isAllowedUploadPath(filename) {
    return ALLOWED_UPLOAD_PREFIXES.some((re) => re.test(filename));
  }

  async buildRelativePath(filename, parentId) {
    if (!parentId) {
      return filename;
    }
    const parentFolder = await this.repo.findById(parentId);
    if (!parentFolder) {
      return filename;
    }
    const parentPath = await this.buildRelativePath(
      parentFolder.filename,
      parentFolder.parent,
    );
    return parentPath + '/' + filename;
  }

  async presign({ filename }) {
    if (!this.isAllowedUploadPath(filename)) {
      throw new AppError(
        "Invalid upload path. Must start with 'workspace/' or 'project/'",
        403,
      );
    }
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: filename,
    });
    const signedUrl = await getSignedUrl(this.r2, command, { expiresIn: 3600 });
    return { signedUrl, url: `/api/files/r2/${filename}`, path: filename };
  }

  async uploadR2({ filename, buffer, mimeType }) {
    if (!this.isAllowedUploadPath(filename)) {
      throw new AppError(
        "Invalid upload path. Must start with 'workspace/' or 'project/'",
        403,
      );
    }
    await this.r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: filename,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
    return { url: `/api/files/r2/${filename}`, path: filename };
  }

  async upload(scopeId, payload, userId) {
    const {
      filename,
      size,
      mimeType,
      url,
      thumbnail,
      parentId,
      metaData,
      fileBase64,
    } = payload;

    const scopeContext = this.getScopeContext(scopeId, payload);
    const { linkedTo, workspaceId } = scopeContext;

    let existingFile = await this.findExistingFile(filename, parentId, linkedTo);

    let fileRecord;
    if (existingFile) {
      existingFile.size = size || existingFile.size;
      existingFile.mimeType = mimeType || existingFile.mimeType;
      existingFile.url = url || existingFile.url;
      existingFile.thumbnail = thumbnail || existingFile.thumbnail;
      existingFile.metaData = metaData || existingFile.metaData;
      existingFile.uploadedAt = new Date();
      fileRecord = await this.repo.save(existingFile);
    } else {
      fileRecord = await this.repo.create({
        filename,
        size,
        mimeType,
        url,
        thumbnail,
        workspaceId,
        linkedTo,
        parent: parentId || null,
        metaData: metaData || {},
        authorId: userId,
      });
    }

    const syncWarning = await this.afterUpload(fileRecord, payload, linkedTo);
    return { file: fileRecord, overwritten: !!existingFile, ...(syncWarning && { syncWarning }) };
  }

  async createFolder(scopeId, payload, userId) {
    const { name, parentId } = payload;

    const scopeContext = this.getScopeContext(scopeId, payload);
    const { linkedTo, workspaceId } = scopeContext;

    const existing = await this.repo.findOne({
      filename: name,
      workspaceId,
      'linkedTo.entityType': linkedTo.entityType,
      'linkedTo.entityId': linkedTo.entityId,
      parent: parentId || null,
      isFolder: true,
      trashedAt: null,
    });
    if (existing) {
      return existing;
    }
    return this.repo.create({
      filename: name,
      workspaceId,
      linkedTo,
      parent: parentId || null,
      authorId: userId,
      isFolder: true,
    });
  }

  getFile(fileId) {
    return this.repo.findById(fileId);
  }

  updateFile(fileId, updates, userId) {
    return this.repo.updateById(fileId, updates);
  }

  async deleteFile(fileId, userId) {
    return this.trashFile(fileId);
  }

  async toggleStar(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }
    file.starred = !file.starred;
    await this.repo.save(file);
    return file;
  }

  async trashFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }

    const trashRecursive = async (id) => {
      const children = await this.repo.findChildren(id);
      for (const child of children) {
        child.trashedAt = new Date();
        await this.repo.save(child);
        if (child.isFolder) {
          await trashRecursive(child._id);
        }
      }
    };

    file.trashedAt = new Date();
    await this.repo.save(file);
    if (file.isFolder) {
      await trashRecursive(fileId);
    }

    return file;
  }

  async restoreFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }

    const restoreRecursive = async (id) => {
      const children = await this.repo.findChildren(id);
      for (const child of children) {
        child.trashedAt = null;
        await this.repo.save(child);
        if (child.isFolder) {
          await restoreRecursive(child._id);
        }
      }
    };

    file.trashedAt = null;
    await this.repo.save(file);
    if (file.isFolder) {
      await restoreRecursive(fileId);
    }

    return file;
  }

  async permanentlyDeleteFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }

    const deleteRecursive = async (id) => {
      const children = await this.repo.findChildren(id);
      for (const child of children) {
        if (child.isFolder) {
          await deleteRecursive(child._id);
        }
        if (child.url) {
          const key = child.url.split('/api/files/')[1];
          if (key) {
            await this.r2
              .send(
                new DeleteObjectCommand({
                  Bucket: process.env.R2_BUCKET_NAME,
                  Key: key,
                }),
              )
              .catch(() => {});
          }
        }
        await this.repo.deleteById(child._id);
      }
    };

    if (file.isFolder) {
      await deleteRecursive(fileId);
    }

    if (file.url) {
      const key = file.url.split('/api/files/')[1];
      if (key) {
        await this.r2
          .send(
            new DeleteObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: key,
            }),
          )
          .catch(() => {});
      }
    }
    await this.repo.deleteById(fileId);
  }

  async shareFile(fileId, { userId, permission }) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }
    const existing = file.sharedWith.find(
      (s) => s.userId.toString() === userId,
    );
    if (existing) {
      existing.permission = permission;
    } else {
      file.sharedWith.push({ userId, permission });
    }
    await this.repo.save(file);
    return file;
  }

  async renameFile(fileId, name) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }
    file.filename = name;
    await this.repo.save(file);
    return file;
  }

  async moveFile(fileId, parentId) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }
    file.parent = parentId || null;
    await this.repo.save(file);
    return file;
  }

  async updateMetadata(fileId, metaData) {
    const file = await this.repo.findById(fileId);
    if (!file) {
      throw new AppError('File not found', 404);
    }
    file.metaData = metaData;
    await this.repo.save(file);
    return file;
  }

  async proxyR2(key, res) {
    try {
      const r2Resp = await this.r2.send(
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }),
      );
      if (r2Resp.ContentType) {
        res.set('Content-Type', r2Resp.ContentType);
      }
      r2Resp.Body.pipe(res);
    } catch (err) {
      if (err.name !== 'NoSuchKey') {
        console.error('proxyR2 error for key:', key, err);
      }
      res.status(404).json({ error: 'File not found' });
    }
  }

  /**
   * Abstract scope context meant to be overridden by subclasses.
   * If scopeId is null, attempts to parse context from payload (for legacy fallback routes).
   */
  getScopeContext(entityId, payload = {}) {
    if (entityId) {
      return {
        workspaceId: null,
        linkedTo: { entityType: null, entityId: null },
      };
    }
    const { workspaceId, projectId, pageId } = payload;
    const linkedTo = pageId
      ? { entityType: 'Page', entityId: pageId }
      : projectId
        ? { entityType: 'Project', entityId: projectId }
        : { entityType: null, entityId: null };
    return { workspaceId: workspaceId || null, linkedTo };
  }

  /**
   * Hook for handling post-upload logic (e.g. Page compiler sync).
   * Overridden by subclasses.
   */
  async afterUpload(fileRecord, payload, linkedTo) {
    return null; // return syncWarning if any
  }

  /**
   * Hook for finding an existing file during upload.
   * Overridden by subclasses if they have different uniqueness rules.
   */
  async findExistingFile(filename, parentId, linkedTo) {
    return this.repo.findOne({ 
      filename, 
      'linkedTo.entityId': linkedTo.entityId || null, 
      parent: parentId || null, 
      isFolder: false, 
      trashedAt: null 
    });
  }

  /**
   * Fetches files using the repository's polymorphic context scoping.
   */
  getFiles(entityId, filters = {}) {
    return this.repo.getFiles(entityId, filters);
  }
}

export class WorkspaceFileService extends FileService {
  constructor({ workspaceFileRepository, projectRepository, r2 }) {
    super({ fileRepository: workspaceFileRepository, r2 });
    this.projectRepo = projectRepository;
  }

  getScopeContext(workspaceId) {
    return { workspaceId, linkedTo: { entityType: null, entityId: null } };
  }

  /**
   * Returns workspace-level files + files from all projects in this workspace.
   * Supports optional filters: { projectId } for single-project drill-down.
   */
  async getHomeFiles(workspaceId, filters = {}) {
    const projects = await this.projectRepo.findByWorkspace(workspaceId);
    const projectIds = projects.map((p) => p._id);
    return this.repo.getWorkspaceAllFiles(workspaceId, projectIds, filters);
  }
}

export class ProjectFileService extends FileService {
  constructor({ projectFileRepository, r2 }) {
    super({ fileRepository: projectFileRepository, r2 });
  }

  getScopeContext(projectId) {
    return {
      workspaceId: null,
      linkedTo: { entityType: 'Project', entityId: projectId },
    };
  }
}

export class PageFileService extends FileService {
  constructor({ pageFileRepository, r2 }) {
    super({ fileRepository: pageFileRepository, r2 });
  }

  getScopeContext(pageId) {
    return { workspaceId: null, linkedTo: { entityType: 'Page', entityId: pageId } };
  }

  async findExistingFile(filename, parentId, linkedTo) {
    return this.repo.findOne({ 
      filename, 
      'linkedTo.entityType': 'Page', 
      'linkedTo.entityId': linkedTo.entityId, 
      parent: parentId || null, 
      isFolder: false 
    });
  }

  async afterUpload(fileRecord, payload, linkedTo) {
    if (payload.url) {
      try {
        const relPath = await this.buildRelativePath(payload.filename, payload.parentId || null);
        eventBus.emit(Events.CHILD_PAGE_CREATED, {
          pageId: linkedTo.entityId,
          file: fileRecord,
          fileBase64: payload.fileBase64,
          relPath
        });
      } catch (err) {
        console.warn('[file.service] compiler sync event dispatch failed:', err.message);
        return err.message;
      }
    }
    return null;
  }
}
