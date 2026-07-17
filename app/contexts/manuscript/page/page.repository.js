import { PageModel } from "./page.schema.js";
import ProjectModel from "../../organization/project/project.schema.js";

export class PageRepository {
  constructor() {
    this.model = PageModel;
  }
  async findByWorkspace(workspaceId) {
    // Page schema has no direct workspace field; join via project
    const projectIds = await ProjectModel.find({ workspace: workspaceId }).distinct("_id");
    return this.model.find({ project: { $in: projectIds }, parentPage: null })
      .populate("project", "_id name workspace")
      .populate("mainFile", "_id title")
      .sort({ updatedAt: -1 });
  }
  findByProject(id) { return this.model.find({ project: id, parentPage: null }).populate("project", "_id name workspace").populate("mainFile", "_id title").sort({ updatedAt: -1 }); }
  findById(id) { return this.model.findById(id)
    .populate({ path: "project", select: "name workspace", populate: { path: "workspace", select: "_id name url" } })
    .populate("mainFile", "_id title"); }
  findByIdSelect(id, select) { return this.model.findById(id).select(select); }
  findChildPages(parentId, select = "_id title content parentPage") { return this.model.find({ parentPage: parentId }).select(select).lean(); }
  findChildPagesWithMeta(parentId) { return this.model.find({ parentPage: parentId }).select("_id title content updatedAt parentPage").lean(); }
  updateContent(id, content) { return this.model.findByIdAndUpdate(id, { content }, { new: true }).select("_id title content parentPage"); }
  create(data) { return this.model.create(data); }
  updateById(id, data) { return this.model.findByIdAndUpdate(id, data, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }

  searchPages(accessibleProjectIds, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ project: { $in: accessibleProjectIds }, title: searchRegex })
      .limit(5)
      .select("title project updatedAt")
      .populate("project", "name");
  }

  findRecentPages(projectIds, limit = 10) {
    return this.model.find({ project: { $in: projectIds } })
      .populate("author", "name email avatar")
      .sort({ updatedAt: -1 })
      .limit(limit);
  }
}



