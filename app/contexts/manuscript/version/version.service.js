import { AppError } from "../../../lib/AppError.js";
import { syncFileToCompilerReliable, bulkSyncToCompiler } from "../../../config/compiler-sync.js";

export class VersionService {
  constructor({ versionRepository, pageRepository }) {
    this.versionRepository = versionRepository;
    this.pageRepository = pageRepository;
  }

  _pageTexName(page) { return (page.title || "untitled").replace(/[^a-z0-9_-]/gi, "_").toLowerCase() + ".tex"; }
  _textToBase64(text) { return Buffer.from(text || "", "utf8").toString("base64"); }

  getVersions(pageId) { return this.versionRepository.findManualSaves(pageId); }

  async createVersion(pageId, { label = "" }, userId) {
    const page = await this.pageRepository.findByIdSelect(pageId, "content title parentPage");
    if (!page) throw new AppError("Page not found", 404);
    const projectPageId = page.parentPage ?? page._id;
    const version = await this.versionRepository.create({ page: pageId, projectPageId, content: page.content ?? "", title: page.title, label, savedBy: userId, eventType: "manual_save", fileName: this._pageTexName(page) });
    await version.populate("savedBy", "name avatar");
    return version;
  }

  async restoreVersion(pageId, versionId) {
    const version = await this.versionRepository.findOne({ _id: versionId, page: pageId });
    if (!version) throw new AppError("Version not found", 404);
    const page = await this.pageRepository.updateContent(pageId, version.content);
    if (page) await syncFileToCompilerReliable((page.parentPage ?? page._id).toString(), this._pageTexName(page), this._textToBase64(page.content ?? ""));
    return page;
  }

  async deleteVersion(pageId, versionId) {
    const v = await this.versionRepository.deleteOne({ _id: versionId, page: pageId });
    if (!v) throw new AppError("Version not found", 404);
  }

  getHistory(projectPageId) { return this.versionRepository.findHistory(projectPageId); }

  async restoreHistory(folderId, eventId) {
    const targetEvent = await this.versionRepository.findOne({ _id: eventId, projectPageId: folderId });
    if (!targetEvent) throw new AppError("Event not found", 404);
    const T = targetEvent.createdAt;
    const [rootPage, childFiles] = await Promise.all([
      this.pageRepository.findByIdSelect(folderId, "_id title content parentPage"),
      this.pageRepository.findChildPages(folderId),
    ]);
    if (!rootPage) throw new AppError("Project not found", 404);
    const restoredFiles = {};
    const restored = [];
    for (const p of [rootPage.toObject ? rootPage.toObject() : rootPage, ...childFiles]) {
      const snapshot = await this.versionRepository.findSnapshotBefore(p._id, T);
      if (snapshot) {
        await this.pageRepository.updateContent(p._id, snapshot.content);
        restoredFiles[this._pageTexName(p)] = this._textToBase64(snapshot.content ?? "");
        restored.push({ pageId: p._id.toString(), title: p.title, content: snapshot.content ?? "" });
      }
    }
    bulkSyncToCompiler(folderId, restoredFiles);
    return { restored, restoredAt: T };
  }
}




