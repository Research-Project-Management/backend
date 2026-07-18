import { PageCommentModel, TaskCommentModel } from "./comment.schema.js";

export class PageCommentRepository {
  constructor() {
    this.model = PageCommentModel;
  }
  find(filter) { return this.model.find(filter).sort({ createdAt: -1 }).limit(200); }
  findById(id) { return this.model.findById(id); }
  findOne(id, pageId) { return this.model.findOne({ _id: id, pageId: pageId }); }
  create(data) { return this.model.create(data); }
}

export class TaskCommentRepository {
  constructor() {
    this.model = TaskCommentModel;
  }
  count(taskId) { return this.model.countDocuments({ taskId: taskId }); }
  find(taskId) { return this.model.find({ taskId: taskId }).sort({ createdAt: -1 }).limit(200); }
  findById(id) { return this.model.findById(id); }
  findOne(id, taskId) { return this.model.findOne({ _id: id, taskId: taskId }); }
  create(data) { return this.model.create(data); }
  aggregateCountByIds(taskIds) {
    return this.model.aggregate([
      { $match: { taskId: { $in: taskIds.map(String) } } },
      { $group: { _id: "$taskId", count: { $sum: 1 } } },
    ]);
  }
}
