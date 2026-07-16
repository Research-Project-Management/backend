import ProjectModel from "./project.schema.js";

export class ProjectRepository {
  constructor() {
    this.model = ProjectModel;
  }
  findByWorkspace(workspaceId) { return this.model.find({ workspace: workspaceId }); }
  findById(id) { return this.model.findById(id).populate({ path: "members.role", model: "Role" }); }
  findByIdPopulated(id) {
    return this.model.findById(id).populate([
      { path: "members.user", select: "name email avatar" },
      { path: "createdBy", select: "name email avatar" },
    ]);
  }
  create(data) { return this.model.create(data); }
  updateById(id, updates) { return this.model.findByIdAndUpdate(id, updates, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  incrementTaskSequence(id) { return this.model.findByIdAndUpdate(id, { $inc: { taskSequence: 1 } }, { new: true }); }
  setTaskSequence(id, seq) { return this.model.findByIdAndUpdate(id, { $set: { taskSequence: seq } }, { new: true }); }

  findAccessibleProjectIds(workspaceId, userId, isPrivileged) {
    const query = { workspace: workspaceId };
    if (!isPrivileged) query["members.user"] = userId;
    return this.model.find(query).distinct("_id");
  }

  searchProjects(accessibleIds, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ _id: { $in: accessibleIds }, name: searchRegex }).limit(5).select("name avatar updatedAt");
  }
}



