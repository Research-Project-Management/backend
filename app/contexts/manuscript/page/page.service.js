import { AppError } from "../../../lib/AppError.js";
import { getIO } from "../../../config/socket.js";

export class PageService {
  constructor({ pageRepository}) {
    this.repo = pageRepository;
    
  }

  getWorkspacePages(workspaceId) { return this.repo.findByWorkspace(workspaceId); }
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

  async deletePage(pageId, userId) { await this.repo.deleteById(pageId); }

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
}





