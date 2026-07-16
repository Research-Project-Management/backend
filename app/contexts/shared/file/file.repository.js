import FileModel from "./file.schema.js";

export class FileRepository {
  constructor() {
    this.model = FileModel;
  }
  findById(id) { return this.model.findById(id); }
  findOneById(id) { return this.model.findById(id).lean(); }
  findByProject(projectId, parentId, includeTrash) {
    return this.model.find({ project: projectId, parent: parentId || null, pageId: null, ...(includeTrash ? {} : { trashedAt: null }) })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }
  findByWorkspace(workspaceId, q) {
    return this.model.find({ workspace: workspaceId, ...q })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }
  findByPage(pageId, parentId) {
    return this.model.find({ pageId, parent: parentId || null, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }
  findByPageId(pageId) { return this.model.find({ pageId, trashedAt: null, isFolder: false, url: { $exists: true, $ne: null } }).lean(); }
  findOne(filter) { return this.model.findOne(filter); }
  create(data) { return this.model.create(data); }
  save(doc) { return doc.save(); }
  updateById(id, data) { return this.model.findByIdAndUpdate(id, data, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  countByProject(projectId) { return this.model.countDocuments({ project: projectId, trashedAt: null }); }

  aggregateProjectStats(projectId) {
    return this.model.aggregate([
      { $match: { project: projectId, trashedAt: null } },
      { $group: { _id: null, fileCount: { $sum: 1 }, totalSize: { $sum: "$size" } } }
    ]);
  }

  findWorkspaceFiles(workspaceId, parentId) {
    return this.model.find({ workspace: workspaceId, project: null, parent: parentId || null, pageId: null, trashedAt: null })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findMyWorkspaceFiles(workspaceId, userId) {
    return this.model.find({ workspace: workspaceId, project: null, pageId: null, author: userId, trashedAt: null })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findStarredWorkspaceFiles(workspaceId) {
    return this.model.find({ workspace: workspaceId, project: null, pageId: null, starred: true, trashedAt: null })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findSharedWorkspaceFiles(workspaceId, userId) {
    return this.model.find({ workspace: workspaceId, project: null, pageId: null, "sharedWith.user": userId, trashedAt: null })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findTrashedWorkspaceFiles(workspaceId) {
    return this.model.find({ workspace: workspaceId, project: null, pageId: null, trashedAt: { $ne: null } })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findProjectMyFiles(projectId, userId) {
    return this.model.find({ project: projectId, pageId: null, author: userId, trashedAt: null })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findProjectStarredFiles(projectId) {
    return this.model.find({ project: projectId, pageId: null, starred: true, trashedAt: null })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findProjectSharedFiles(projectId, userId) {
    return this.model.find({ project: projectId, pageId: null, "sharedWith.user": userId, trashedAt: null })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  findProjectTrashedFiles(projectId) {
    return this.model.find({ project: projectId, pageId: null, trashedAt: { $ne: null } })
      .populate("author", "name email avatar").sort({ isFolder: -1, filename: 1 });
  }

  searchFiles(workspaceId, accessibleProjectIds, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ workspace: workspaceId, $or: [{ project: { $in: accessibleProjectIds } }, { project: null }], filename: searchRegex, trashedAt: null })
      .limit(5)
      .select("filename mimeType size updatedAt project isFolder");
  }

  findRecentFiles(workspaceId, limit = 10) {
    return this.model.find({ workspace: workspaceId, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ updatedAt: -1 })
      .limit(limit);
  }
}



