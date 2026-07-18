import { r2 } from "../../../config/r2.js";
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { syncFileToCompilerReliable } from "../../../lib/compiler-sync.js";
import { AppError } from "../../../lib/AppError.js";

const ALLOWED_UPLOAD_PREFIXES = [/^workspace\//, /^project\//];

export class FileService {
  constructor({ fileRepository, projectRepository, crossrefClient }) {
    this.repo = fileRepository;
    this.projectRepository = projectRepository;
    this.crossrefClient = crossrefClient;
  }

  _isAllowedUploadPath(name) { return ALLOWED_UPLOAD_PREFIXES.some((re) => re.test(name)); }

  async _buildRelativePath(filename, parentId) {
    if (!parentId) return filename;
    const parent = await this.repo.findById(parentId);
    if (!parent) return filename;
    const parentPath = await this._buildRelativePath(parent.filename, parent.parent);
    return parentPath + "/" + filename;
  }

  async presign({ filename }) {
    if (!this._isAllowedUploadPath(filename)) throw new AppError("Invalid upload path. Must start with 'workspace/' or 'project/'", 403);
    const url = await getSignedUrl(r2, new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: filename }), { expiresIn: 3600 });
    return { url, path: filename };
  }

  async upload({ filename, size, mimeType, url, thumbnail, workspaceId, projectId, parentId, metaData, scope, parentPageId, fileBase64 }, userId) {
    const resolvedProjectId = scope === "workspace" ? null : (projectId || null);
    const linkedTo = parentPageId 
      ? { entityType: "Page", entityId: parentPageId } 
      : resolvedProjectId 
        ? { entityType: "Project", entityId: resolvedProjectId } 
        : { entityType: null, entityId: null };

    const existingFile = parentPageId ? await this.repo.findOne({ filename, "linkedTo.entityType": "Page", "linkedTo.entityId": parentPageId, parent: parentId || null, isFolder: false }) : null;
    let file;
    if (existingFile) {
      existingFile.url = url; existingFile.size = size; existingFile.mimeType = mimeType;
      if (thumbnail !== undefined) existingFile.thumbnail = thumbnail;
      if (metaData) existingFile.metaData = metaData;
      existingFile.trashedAt = null; existingFile.updatedAt = new Date();
      await existingFile.save(); file = existingFile;
    } else {
      file = await this.repo.create({ filename, size, mimeType, url, thumbnail, workspaceId, linkedTo, parent: parentId || null, authorId: userId, metaData: metaData || {}, isFolder: false });
    }
    if (parentPageId && url) {
      try {
        const relPath = await this._buildRelativePath(filename, parentId || null);
        if (fileBase64) { await syncFileToCompilerReliable(parentPageId, relPath, fileBase64); }
        else {
          const key = url.split("/api/files/")[1];
          if (key) { const r2Resp = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })); const chunks = []; for await (const chunk of r2Resp.Body) chunks.push(chunk); await syncFileToCompilerReliable(parentPageId, relPath, Buffer.concat(chunks).toString("base64")); }
        }
      } catch (err) { console.warn("[file.service] compiler sync failed:", err.message); return { file, overwritten: !!existingFile, syncWarning: err.message }; }
    }
    return { file, overwritten: !!existingFile };
  }

  async createFolder({ name, workspaceId, projectId, parentId, scope, parentPageId }, userId) {
    const resolvedProjectId = scope === "workspace" ? null : (projectId || null);
    const linkedTo = parentPageId 
      ? { entityType: "Page", entityId: parentPageId } 
      : resolvedProjectId 
        ? { entityType: "Project", entityId: resolvedProjectId } 
        : { entityType: null, entityId: null };

    const existing = await this.repo.findOne({
      filename: name,
      workspaceId,
      "linkedTo.entityType": linkedTo.entityType,
      "linkedTo.entityId": linkedTo.entityId,
      parent: parentId || null,
      isFolder: true,
      trashedAt: null
    });
    if (existing) return existing;
    return this.repo.create({ filename: name, workspaceId, linkedTo, parent: parentId || null, authorId: userId, isFolder: true });
  }

  getProjectFiles(projectId, { parentId, includeTrash }) { return this.repo.findByProject(projectId, parentId, includeTrash); }
  getWorkspaceFiles(workspaceId, query) { return this.repo.findByWorkspace(workspaceId, query); }
  getPageFiles(pageId, { parentId }) { return this.repo.findByPage(pageId, parentId); }
  getFile(id) { return this.repo.findById(id); }
  updateFile(id, updates, userId) { return this.repo.updateById(id, updates); }

  async deleteFile(id, userId) {
    // By default, deleteFile from query actions is equivalent to trashing
    return this.trashFile(id);
  }

  async getWorkspaceHome(workspaceId, userId) {
    const projects = await this.projectRepository.findByWorkspace(workspaceId);
    const projectStats = await Promise.all(projects.map(async (project) => {
      const stats = await this.repo.aggregateProjectStats(project._id);
      return {
        _id: project._id,
        name: project.name,
        fileCount: stats[0]?.fileCount || 0,
        totalSize: stats[0]?.totalSize || 0
      };
    }));

    const workspaceFiles = await this.repo.findWorkspaceFiles(workspaceId, null);

    return { projects: projectStats, workspaceFiles };
  }

  async getWorkspaceAllFiles(workspaceId, parentId) {
    return this.repo.findWorkspaceFiles(workspaceId, parentId);
  }

  async getWorkspaceMyFiles(workspaceId, userId) {
    return this.repo.findMyWorkspaceFiles(workspaceId, userId);
  }

  async getWorkspaceStarredFiles(workspaceId) {
    return this.repo.findStarredWorkspaceFiles(workspaceId);
  }

  async getWorkspaceSharedFiles(workspaceId, userId) {
    return this.repo.findSharedWorkspaceFiles(workspaceId, userId);
  }

  async getWorkspaceTrashedFiles(workspaceId) {
    return this.repo.findTrashedWorkspaceFiles(workspaceId);
  }

  async getProjectMyFiles(projectId, userId) {
    return this.repo.findProjectMyFiles(projectId, userId);
  }

  async getProjectStarredFiles(projectId) {
    return this.repo.findProjectStarredFiles(projectId);
  }

  async getProjectSharedFiles(projectId, userId) {
    return this.repo.findProjectSharedFiles(projectId, userId);
  }

  async getProjectTrashedFiles(projectId) {
    return this.repo.findProjectTrashedFiles(projectId);
  }

  async toggleStar(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    file.starred = !file.starred;
    await file.save();
    return file;
  }

  async trashFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    file.trashedAt = new Date();
    await file.save();
    // Recursively trash children if folder
    if (file.isFolder) {
      await this._trashChildren(fileId);
    }
    return file;
  }

  async _trashChildren(parentId) {
    const children = await this.repo.findChildren(parentId);
    for (const child of children) {
      child.trashedAt = new Date();
      await child.save();
      if (child.isFolder) await this._trashChildren(child._id);
    }
  }

  async restoreFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    file.trashedAt = null;
    await file.save();
    // Recursively restore children if folder
    if (file.isFolder) {
      await this._restoreChildren(fileId);
    }
    return file;
  }

  async _restoreChildren(parentId) {
    const children = await this.repo.findChildren(parentId);
    for (const child of children) {
      child.trashedAt = null;
      await child.save();
      if (child.isFolder) await this._restoreChildren(child._id);
    }
  }

  async permanentlyDeleteFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    // Recursively delete children first if folder
    if (file.isFolder) {
      await this._permanentlyDeleteChildren(fileId);
    }
    if (file.url) {
      const key = file.url.split("/api/files/")[1];
      if (key) await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })).catch(() => {});
    }
    await this.repo.deleteById(fileId);
  }

  async _permanentlyDeleteChildren(parentId) {
    const children = await this.repo.findChildren(parentId);
    for (const child of children) {
      if (child.isFolder) await this._permanentlyDeleteChildren(child._id);
      if (child.url) {
        const key = child.url.split("/api/files/")[1];
        if (key) await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })).catch(() => {});
      }
      await this.repo.deleteById(child._id);
    }
  }

  async shareFile(fileId, { userId, permission }) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    const existing = file.sharedWith.find(s => s.user.toString() === userId);
    if (existing) {
      existing.permission = permission;
    } else {
      file.sharedWith.push({ user: userId, permission });
    }
    await file.save();
    return file;
  }

  async renameFile(fileId, name) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    file.filename = name;
    await file.save();
    return file;
  }

  async moveFile(fileId, parentId) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    file.parent = parentId || null;
    await file.save();
    return file;
  }

  async updateMetadata(fileId, metaData) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    file.metaData = metaData;
    await file.save();
    return file;
  }

  async crossrefSearch(query, rows = 5) {
    return this.crossrefClient.search(query, rows);
  }

  async crossrefDoi(rawDoi) {
    return this.crossrefClient.getByDoi(rawDoi);
  }


  async proxyR2(key, res) {
    try { const r2Resp = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })); if (r2Resp.ContentType) res.set("Content-Type", r2Resp.ContentType); r2Resp.Body.pipe(res); }
    catch (err) { 
      if (err.name !== "NoSuchKey") console.error("proxyR2 error for key:", key, err);
      res.status(404).json({ error: "File not found" }); 
    }
  }
}




