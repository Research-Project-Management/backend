import { AppError } from "../../../lib/AppError.js";
import { getIO } from "../../../config/socket.js";
import FileModel from "../../shared/file/file.schema.js";
import { textToBase64, bulkSyncToCompiler, buildRelativePath } from "../../../config/compiler-sync.js";
import WorkspaceModel from "../../organization/workspace/workspace.schema.js";


export class PageService {
  constructor({ pageRepository}) {
    this.repo = pageRepository;
    
  }

  async getWorkspacePages(workspaceInput) {
    // workspaceInput may be a slug (url) or an ObjectId string
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(workspaceInput);
    let workspaceId = workspaceInput;
    if (!isObjectId) {
      const ws = await WorkspaceModel.findOne({ url: workspaceInput }).select("_id").lean();
      if (!ws) return [];
      workspaceId = ws._id.toString();
    }
    return this.repo.findByWorkspace(workspaceId);
  }
  getProjectPages(projectId) { return this.repo.findByProject(projectId); }
  getPage(id) { return this.repo.findById(id); }

  async createPage(projectId, data, userId) {
    const rootPage = await this.repo.create({
      ...data,
      project: projectId,
      author: userId,
      content: data.content ?? "",
      parentPage: null,
      mainFile: null
    });

    const mainFile = await this.repo.create({
      title: "main.tex",
      content: "\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}",
      status: "draft",
      project: projectId,
      author: userId,
      parentPage: rootPage._id
    });

    rootPage.mainFile = mainFile._id;
    await rootPage.save();

    getIO()?.to("project:" + projectId).emit("page:created", { page: rootPage });
    return { page: rootPage, mainFile };
  }

  async updatePage(pageId, data, userId) {
    const page = await this.repo.updateById(pageId, data);
    if (page) getIO()?.to("page:" + pageId).emit("page:updated", { page });
    return page;
  }

  async deletePage(pageId, userId) {
    const page = await this.repo.findById(pageId);
    if (page) {
      await this.repo.deleteById(pageId);
      getIO()?.to("project:" + page.project).emit("page:deleted", { pageId });
    }
  }

  async duplicatePage(pageId, userId) {
    const original = await this.repo.findById(pageId);
    if (!original) throw new AppError("Page not found", 404);
    const raw = original.toObject ? original.toObject() : { ...original };
    const { _id, createdAt, updatedAt, ...rest } = raw;
    return this.repo.create({ ...rest, title: rest.title + " (Copy)", author: userId });
  }

  getChildPages(pageId) {
    return this.repo.findChildPagesWithMeta(pageId);
  }

  async createChildPage(parentPageId, data, userId) {
    const parentPage = await this.repo.findById(parentPageId);
    if (!parentPage) throw new AppError("Parent page not found", 404);
    const child = await this.repo.create({
      ...data,
      project: parentPage.project,
      parentPage: parentPageId,
      author: userId,
      content: data.content ?? ""
    });
    getIO()?.to("page:" + parentPageId).emit("file:created", { file: child });
    return child;
  }

  async setMainFile(pageId, fileId) {
    const page = await this.repo.findById(pageId);
    if (!page) throw new AppError("Page not found", 404);
    page.mainFile = fileId;
    await page.save();
    return page;
  }

  async updateThumbnail(pageId, dataUrl) {
    const page = await this.repo.findById(pageId);
    if (!page) throw new AppError("Page not found", 404);
    page.pdfThumbnail = dataUrl;
    await page.save();
    return page;
  }

  async syncProject(pageId) {
    const rootPage = await this.repo.findById(pageId);
    if (!rootPage) throw new AppError("Project not found", 404);

    const filesToSync = {};

    // 1. Root page content (usually empty in this architecture, but we'll sync it as _root.tex if needed, skip for now to match RPM-BE)
    
    // 2. Child pages (text files)
    const childPages = await this.repo.findChildPagesWithMeta(pageId);
    for (const child of childPages) {
      filesToSync[child.title] = textToBase64(child.content || "");
    }

    // 3. Binary file assets (images, etc)
    const assets = await FileModel.find({ project: rootPage.project }).lean();
    for (const asset of assets) {
      // Build relative path
      const relPath = await buildRelativePath(asset.filename, asset.parent);
      if (asset.compilerBase64Cache) {
         filesToSync[relPath] = asset.compilerBase64Cache;
      }
    }

    await bulkSyncToCompiler(pageId, filesToSync);
    return { synced: true, fileCount: Object.keys(filesToSync).length };
  }
}






