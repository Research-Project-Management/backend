import FileModel from "./file.schema.js";

export class FileRepository {
  constructor() {
    this.model = FileModel;
  }
  findById(id) { return this.model.findById(id); }
  findOneById(id) { return this.model.findById(id).lean(); }
  findByProject(projectId, parentId, includeTrash) {
    return this.model.find({ "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, parent: parentId || null, ...(includeTrash ? {} : { trashedAt: null }) })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }
  findByWorkspace(workspaceId, q) {
    return this.model.find({ workspaceId, ...q })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }
  findByPage(pageId, parentId) {
    return this.model.find({ "linkedTo.entityType": "Page", "linkedTo.entityId": pageId, parent: parentId || null, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }
  findByPageId(pageId) { return this.model.find({ "linkedTo.entityType": "Page", "linkedTo.entityId": pageId, trashedAt: null, isFolder: false, url: { $exists: true, $ne: null } }).lean(); }
  findOne(filter) { return this.model.findOne(filter); }
  create(data) { return this.model.create(data); }
  save(doc) { return doc.save(); }
  updateById(id, data) { return this.model.findByIdAndUpdate(id, data, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  findChildren(parentId) { return this.model.find({ parent: parentId }); }
  updateManyByParent(parentId, updates) { return this.model.updateMany({ parent: parentId }, updates); }
  deleteManyByParent(parentId) { return this.model.deleteMany({ parent: parentId }); }
  countByProject(projectId) { return this.model.countDocuments({ "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, trashedAt: null }); }
  findAllActiveByProject(projectId) {
    return this.model.find({ "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, trashedAt: null }).sort({ createdAt: -1 });
  }

  aggregateProjectStats(projectId) {
    return this.model.aggregate([
      { $match: { "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, trashedAt: null } },
      { $group: { _id: null, fileCount: { $sum: 1 }, totalSize: { $sum: "$size" } } }
    ]);
  }

  findWorkspaceFiles(workspaceId, parentId) {
    return this.model.find({ workspaceId, "linkedTo.entityType": null, parent: parentId || null, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findMyWorkspaceFiles(workspaceId, userId) {
    return this.model.find({ workspaceId, "linkedTo.entityType": null, authorId: userId, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findStarredWorkspaceFiles(workspaceId) {
    return this.model.find({ workspaceId, "linkedTo.entityType": null, starred: true, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findSharedWorkspaceFiles(workspaceId, userId) {
    return this.model.find({ workspaceId, "linkedTo.entityType": null, "sharedWith.userId": userId, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findTrashedWorkspaceFiles(workspaceId) {
    return this.model.find({ workspaceId, "linkedTo.entityType": null, trashedAt: { $ne: null } })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findProjectMyFiles(projectId, userId) {
    return this.model.find({ "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, authorId: userId, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findProjectStarredFiles(projectId) {
    return this.model.find({ "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, starred: true, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findProjectSharedFiles(projectId, userId) {
    return this.model.find({ "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, "sharedWith.userId": userId, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  findProjectTrashedFiles(projectId) {
    return this.model.find({ "linkedTo.entityType": "Project", "linkedTo.entityId": projectId, trashedAt: { $ne: null } })
      .populate("author", "name email avatar")
      .sort({ isFolder: -1, filename: 1 });
  }

  searchFiles(workspaceId, accessibleProjectIds, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ 
      workspaceId, 
      $or: [
        { "linkedTo.entityType": "Project", "linkedTo.entityId": { $in: accessibleProjectIds } }, 
        { "linkedTo.entityType": null }
      ], 
      filename: searchRegex, 
      trashedAt: null 
    })
      .limit(5)
      .select("filename mimeType size updatedAt linkedTo isFolder");
  }

  findRecentFiles(workspaceId, limit = 10) {
    return this.model.find({ workspaceId, trashedAt: null })
      .populate("author", "name email avatar")
      .sort({ updatedAt: -1 })
      .limit(limit);
  }
}



