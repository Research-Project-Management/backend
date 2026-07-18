import PageModel from "./page.schema.js";

export class PageRepository {
  constructor() {
    this.model = PageModel;
  }
  async findByWorkspace(workspaceId) {
    return this.model.find({ workspaceId, parentPage: null })
      .populate("mainFile", "_id title")
      .sort({ updatedAt: -1 });
  }
  findByProject(id) { return this.model.find({ projectId: id, parentPage: null }).populate("mainFile", "_id title").sort({ updatedAt: -1 }); }
  findById(id) { 
    return this.model.findById(id)
      .populate("mainFile", "_id title"); 
  }
  findByIdSelect(id, select) { return this.model.findById(id).select(select); }
  findChildPages(parentId, select = "_id title content parentPage") { return this.model.find({ parentPage: parentId }).select(select).lean(); }
  findChildPagesWithMeta(parentId) { return this.model.find({ parentPage: parentId }).select("_id title content updatedAt parentPage").lean(); }
  updateContent(id, content) { return this.model.findByIdAndUpdate(id, { content }, { new: true }).select("_id title content parentPage"); }
  create(data) { return this.model.create(data); }
  updateById(id, data) { return this.model.findByIdAndUpdate(id, data, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }

  searchPages(accessibleProjectIds, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ projectId: { $in: accessibleProjectIds.map(String) }, title: searchRegex })
      .limit(5)
      .select("title projectId updatedAt");
  }

  findRecentPages(projectIds, limit = 10) {
    return this.model.find({ projectId: { $in: projectIds.map(String) } })
      .sort({ updatedAt: -1 })
      .limit(limit);
  }
}



