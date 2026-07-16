import { r2 } from "../../../config/r2.js";
import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { syncFileToCompilerReliable } from "../../../config/compiler-sync.js";
import { AppError } from "../../../lib/AppError.js";

const ALLOWED_UPLOAD_PREFIXES = [/^workspace\//, /^project\//];
const CROSSREF_API = "https://api.crossref.org";

const firstString = (...args) => args.find((a) => typeof a === "string" && a.trim() !== "");

const parseCrossrefWork = (item) => {
  if (!item.title || !item.title.length) return null;
  let year = null;
  const dates = [
    item["published-print"]?.["date-parts"]?.[0]?.[0],
    item["published-online"]?.["date-parts"]?.[0]?.[0],
    item["issued"]?.["date-parts"]?.[0]?.[0],
  ];
  for (const d of dates) {
    if (d && !isNaN(d)) { year = parseInt(d, 10); break; }
  }

  return {
    title: item.title[0],
    authors: (item.author || []).map((a) => {
      if (a.family && a.given) return `${a.family}, ${a.given}`;
      if (a.family) return a.family;
      if (a.name) return a.name;
      return "Unknown";
    }),
    doi: item.DOI || "",
    journal: firstString(item["container-title"]?.[0], item.publisher),
    year,
    type: item.type || "",
    abstract: item.abstract?.replace(/<[^>]+>/g, "") || "",
    url: item.URL || item.url || "",
  };
};

export class FileService {
  constructor({ fileRepository, projectRepository }) {
    this.repo = fileRepository;
    this.projectRepository = projectRepository;
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
    const existingFile = parentPageId ? await this.repo.findOne({ filename, pageId: parentPageId, parent: parentId || null, isFolder: false }) : null;
    let file;
    if (existingFile) {
      existingFile.url = url; existingFile.size = size; existingFile.mimeType = mimeType;
      if (thumbnail !== undefined) existingFile.thumbnail = thumbnail;
      if (metaData) existingFile.metaData = metaData;
      existingFile.trashedAt = null; existingFile.updatedAt = new Date();
      await existingFile.save(); file = existingFile;
    } else {
      file = await this.repo.create({ filename, size, mimeType, url, thumbnail, workspace: workspaceId, project: resolvedProjectId, parent: parentId || null, author: userId, metaData: metaData || {}, isFolder: false, pageId: parentPageId || null });
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
    const existing = await this.repo.findOne({ filename: name, pageId: parentPageId || null, parent: parentId || null, isFolder: true, trashedAt: null });
    if (existing) return existing;
    return this.repo.create({ filename: name, workspace: workspaceId, project: scope === "workspace" ? null : (projectId || null), parent: parentId || null, author: userId, isFolder: true, pageId: parentPageId || null });
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
    return file;
  }

  async restoreFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    file.trashedAt = null;
    await file.save();
    return file;
  }

  async permanentlyDeleteFile(fileId) {
    const file = await this.repo.findById(fileId);
    if (!file) throw new AppError("File not found", 404);
    if (file.url) {
      const key = file.url.split("/api/files/")[1];
      if (key) await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })).catch(() => {});
    }
    await this.repo.deleteById(fileId);
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
    const url = `${CROSSREF_API}/works?query=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,author,editor,issued,published,published-print,published-online,container-title,publisher,publisher-location,ISSN,ISBN,volume,issue,page,type,abstract,URL,score,language,short-container-title,short-title,license,subject`;
    const response = await fetch(url, { headers: { "User-Agent": "Flux/1.0 (mailto:support@aisq.dev)" } });
    if (!response.ok) throw new AppError(`Crossref API error: ${response.status}`, response.status);
    const data = await response.json();
    const items = data?.message?.items || [];
    const totalResults = data?.message?.["total-results"] || 0;
    return { works: items.map(parseCrossrefWork).filter(Boolean), totalResults };
  }

  async crossrefDoi(rawDoi) {
    let cleanDoi = rawDoi.trim();
    try {
      let decoded = decodeURIComponent(cleanDoi).trim();
      if (decoded.includes("%")) decoded = decodeURIComponent(decoded).trim();
      cleanDoi = decoded;
    } catch (e) {}
    cleanDoi = cleanDoi.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").trim();

    const url = `https://doi.org/${cleanDoi}`;
    const response = await fetch(url, { headers: { Accept: "application/vnd.citationstyles.csl+json", "User-Agent": "Flux/1.0 (mailto:support@aisq.dev)" } });
    
    if (response.ok) {
      const data = await response.json();
      return { work: parseCrossrefWork(data) };
    }

    const fallbackUrl = `${CROSSREF_API}/works/${encodeURIComponent(cleanDoi)}`;
    const fallbackResponse = await fetch(fallbackUrl, { headers: { "User-Agent": "Flux/1.0 (mailto:support@aisq.dev)" } });
    if (!fallbackResponse.ok) throw new AppError(`Crossref API error: ${fallbackResponse.status}`, fallbackResponse.status);
    
    const fallbackData = await fallbackResponse.json();
    return { work: parseCrossrefWork(fallbackData?.message || {}) };
  }


  async proxyR2(key, res) {
    try { const r2Resp = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })); if (r2Resp.ContentType) res.set("Content-Type", r2Resp.ContentType); r2Resp.Body.pipe(res); }
    catch (err) { res.status(404).json({ error: "File not found" }); }
  }
}




