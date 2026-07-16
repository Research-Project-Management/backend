import { TaskModel } from "./task.schema.js";

export class TaskRepository {
  constructor() {
    this.model = TaskModel;
  }
  findByProject(projectId, select = "") { return this.model.find({ project: projectId }).select(select); }
  findById(id) {
    return this.model.findById(id)
      .populate("assignee", "name avatar")
      .populate("cycle", "name phase status")
      .populate("parentTask", "title identifier");
  }
  create(data) { return this.model.create(data); }
  updateById(id, updates) {
    return this.model.findByIdAndUpdate(id, updates, { new: true })
      .populate("assignee", "name avatar")
      .populate("cycle", "name phase status");
  }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  bulkUpdate(ids, updates) { return this.model.updateMany({ _id: { $in: ids } }, { $set: updates }); }
  countByProject(projectId) { return this.model.countDocuments({ project: projectId }); }
  findWithPopulate(query, sort = { rank: 1 }) {
    return this.model.find(query)
      .sort(sort)
      .populate("assignee", "name avatar")
      .populate("cycle", "name phase status")
      .populate("parentTask", "title identifier")
      .lean();
  }
  async createAuditLog(data) {
    const { AuditLogModel } = await import("./task.schema.js");
    return AuditLogModel.create(data);
  }
  async findAuditLogs(taskId) {
    const { AuditLogModel } = await import("./task.schema.js");
    return AuditLogModel.find({ task: taskId }).populate("actor", "name avatar").sort({ createdAt: -1 }).limit(100);
  }
  findRecentTasks(projectIds, limit = 10) {
    return this.model.find({ project: { $in: projectIds } })
      .populate("author", "name email avatar")
      .sort({ updatedAt: -1 })
      .limit(limit);
  }
}



