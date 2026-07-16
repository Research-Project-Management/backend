import ProjectCollectionModel from "./project-collection.schema.js";

export class ProjectCollectionRepository {
  async findByProject(projectId) {
    return ProjectCollectionModel.find({ project: projectId })
      .populate("sourceCollection", "name color icon")
      .populate("createdBy", "name email avatar")
      .populate({
        path: "papers.paper",
        match: { deletedAt: null },
        select: "title authors year doi filename mimeType fileUrl size ragDocId ragStatus ragIndexedAt",
      })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(pcId, projectId) {
    return ProjectCollectionModel.findOne({ _id: pcId, project: projectId });
  }

  async create(data) {
    return ProjectCollectionModel.create(data);
  }

  async save(pc) {
    return pc.save();
  }

  async delete(pcId, projectId) {
    return ProjectCollectionModel.findOneAndDelete({ _id: pcId, project: projectId });
  }
}

