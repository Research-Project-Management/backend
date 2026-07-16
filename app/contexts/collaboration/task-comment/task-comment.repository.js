import TaskCommentModel from "./task-comment.schema.js";

export class TaskCommentRepository {
  constructor() {
    this.model = TaskCommentModel;
  }
  count(taskId) { return this.model.countDocuments({ task: taskId }); }
  find(taskId) { return this.model.find({ task: taskId }).sort({ createdAt: -1 }).limit(200); }
  findById(id) { return this.model.findById(id); }
  findOne(id, taskId) { return this.model.findOne({ _id: id, task: taskId }); }
  create(data) { return this.model.create(data); }
  aggregateCountByIds(taskIds) {
    return this.model.aggregate([
      { $match: { task: { $in: taskIds } } },
      { $group: { _id: "$task", count: { $sum: 1 } } },
    ]);
  }
}



