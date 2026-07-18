import ProjectModel from "./project.schema.js";

export class ProjectRepository {
  constructor() {
    this.model = ProjectModel;
  }
  findByWorkspace(workspaceId) { return this.model.find({ workspaceId: workspaceId }); }
  findById(id) { return this.model.findById(id); }
  findByIdPopulated(id) {
    return this.model.findById(id);
  }
  create(data) { return this.model.create(data); }
  updateById(id, updates) { return this.model.findByIdAndUpdate(id, updates, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  incrementTaskSequence(id) { return this.model.findByIdAndUpdate(id, { $inc: { taskSequence: 1 } }, { new: true }); }
  setTaskSequence(id, seq) { return this.model.findByIdAndUpdate(id, { $set: { taskSequence: seq } }, { new: true }); }

  findAccessibleProjectIds(workspaceId, userId, isPrivileged) {
    const query = { workspaceId: workspaceId };
    if (!isPrivileged) query["members.userId"] = userId;
    return this.model.find(query).distinct("_id");
  }

  searchProjects(accessibleIds, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ _id: { $in: accessibleIds }, name: searchRegex }).limit(5).select("name avatar updatedAt");
  }

  async findProjectsWithCount(query, pagination = null) {
    if (pagination) {
      const { skip, limit } = pagination;
      const [projects, total] = await Promise.all([
        this.model.find(query).skip(skip).limit(limit).lean(),
        this.model.countDocuments(query)
      ]);
      return { projects, total };
    }
    const projects = await this.model.find(query).lean();
    return { projects, total: projects.length };
  }
}



