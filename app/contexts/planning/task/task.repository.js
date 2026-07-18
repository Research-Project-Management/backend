import { TaskModel } from "./task.schema.js";

export class TaskRepository {
  constructor() {
    this.model = TaskModel;
  }
  findByProject(projectId, select = "") { return this.model.find({ projectId: projectId }).select(select); }
  findById(id) { return this.model.findById(id).populate("assigneeId authorId cycleId"); }
  async create(data) {
    const doc = await this.model.create(data);
    return this.findById(doc._id);
  }
  updateById(id, updates) { return this.model.findByIdAndUpdate(id, updates, { new: true }).populate("assigneeId authorId cycleId"); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  bulkUpdate(ids, updates) { return this.model.updateMany({ _id: { $in: ids } }, { $set: updates }); }
  countByProject(projectId) { return this.model.countDocuments({ projectId: projectId }); }
  findByQuery(query, sort) {
    return this.model.find(query)
      .sort(sort)
      .lean();
  }
  
  async findTasksWithCount(filter, sort = null, pagination = null) {
    let queryBuilder = this.model.find(filter).populate("assigneeId authorId cycleId");
    if (sort) queryBuilder = queryBuilder.sort(sort);
    if (pagination) queryBuilder = queryBuilder.skip(pagination.skip).limit(pagination.limit);
    
    const [tasks, total] = await Promise.all([
      queryBuilder.lean(),
      this.model.countDocuments(filter)
    ]);
    return { tasks, total };
  }
  async createAuditLog(data) {
    const { AuditLogModel } = await import("./task.schema.js");
    return AuditLogModel.create(data);
  }
  async findAuditLogs(taskId) {
    const { AuditLogModel } = await import("./task.schema.js");
    return AuditLogModel.find({ taskId: taskId }).sort({ createdAt: -1 }).limit(100);
  }
  findRecentTasks(projectIds, limit = 10) {
    return this.model.find({ projectId: { $in: projectIds } })
      .sort({ updatedAt: -1 })
      .limit(limit);
  }
}



