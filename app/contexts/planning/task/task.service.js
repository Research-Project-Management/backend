import { getIO } from "../../../config/socket.js";
import { AppError } from "../../../lib/AppError.js";

export class TaskService {
  constructor({ taskRepository, projectRepository, authRepository, taskCommentRepository}) {
    this.taskRepository = taskRepository;
    this.projectRepository = projectRepository;
    this.authRepository = authRepository;
    this.taskCommentRepository = taskCommentRepository;
    
  }

  _getTaskDueState(dueDateValue) {
    if (!dueDateValue) return { isOverdue: false, dueState: "none" };
    const dueDate = new Date(dueDateValue);
    if (Number.isNaN(dueDate.getTime())) return { isOverdue: false, dueState: "none" };
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
    const isOverdue = dueDate.getTime() < endOfToday.getTime();
    return { isOverdue, dueState: isOverdue ? "overdue" : "onTime" };
  }

  _getTaskPermissions(task, projectRole, userId) {
    const canWrite = projectRole === "manager" || projectRole === "member";
    const isAuthor = task?.author?.toString?.() === userId;
    return { canEdit: canWrite, canMove: canWrite, canDuplicate: canWrite, canDelete: projectRole === "manager" || isAuthor };
  }

  _toTaskResponse(task, { commentCount = 0, projectRole = "viewer", userId = "" } = {}) {
    const raw = typeof task.toObject === "function" ? task.toObject() : task;
    const { isOverdue, dueState } = this._getTaskDueState(raw.dueDate);
    return { ...raw, commentCount, isOverdue, dueState, permissions: this._getTaskPermissions(task, projectRole, userId) };
  }

  async _generateTaskIdentifier(projectId) {
    let project = await this.projectRepository.findById(projectId);
    if (project && project.taskSequence === 0) {
      const existing = await this.taskRepository.findByProject(projectId, "_id identifier");
      const maxSeq = existing.reduce((max, t) => { const parts = (t.identifier || "").split("-"); const seq = parseInt(parts[parts.length - 1], 10); return Number.isNaN(seq) ? max : Math.max(max, seq); }, 0);
      project = await this.projectRepository.setTaskSequence(projectId, maxSeq);
    }
    const projectDoc = await this.projectRepository.incrementTaskSequence(projectId);
    const prefix = (projectDoc.name || "TASK").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    return { identifier: `${prefix}-${projectDoc.taskSequence}`, projectDoc };
  }

  async _enrichTasksWithComments(tasks, { projectRole, userId }) {
    const taskIds = tasks.map((t) => t._id);
    const counts = await this.taskCommentRepository.aggregateCountByIds(taskIds);
    const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));
    return tasks.map((task) => this._toTaskResponse(task, { commentCount: countMap.get(task._id.toString()) || 0, projectRole, userId }));
  }

  async _createAuditLog(taskId, projectId, actorId, action, previousValue, newValue, description) {
    try {
      const log = await this.taskRepository.createAuditLog({ task: taskId, project: projectId, actor: actorId, action, previous_value: previousValue, new_value: newValue, description });
      const actor = await this.authRepository.findByIdSelect(actorId, "name avatar");
      getIO()?.to(`project:${projectId}`).emit("task-activity:created", { taskId: String(taskId), projectId: String(projectId), action, activityId: log._id.toString(), activity: { _id: log._id.toString(), actor: { _id: String(actorId), name: actor?.name || "User", avatar: actor?.avatar }, action, previous_value: previousValue, new_value: newValue, description: log.description, createdAt: log.createdAt } });
    } catch (_) { /* non-fatal */ }
  }

  async _trackTaskChanges(taskId, projectId, actorId, oldTask, newTask, projectColumns) {
    const changes = [];
    if (oldTask?.assignee?.toString() !== newTask?.assignee?.toString()) changes.push({ action: oldTask?.assignee && !newTask?.assignee ? "assignee_removed" : !oldTask?.assignee && newTask?.assignee ? "assignee_added" : "assignee_changed", previous: oldTask?.assignee, new: newTask?.assignee });
    if ((oldTask?.columnId || "") !== (newTask?.columnId || "")) {
      const oldCol = projectColumns.find((c) => c.id === oldTask?.columnId)?.title || oldTask?.columnId || "(unknown)";
      const newCol = projectColumns.find((c) => c.id === newTask?.columnId)?.title || newTask?.columnId || "(unknown)";
      changes.push({ action: "column_moved", previous: oldTask?.columnId, new: newTask?.columnId, description: `moved from "${oldCol}" to "${newCol}"` });
    }
    if (oldTask?.dueDate?.toString() !== newTask?.dueDate?.toString()) changes.push({ action: "due_date_changed", previous: oldTask?.dueDate, new: newTask?.dueDate });
    if (oldTask?.completed !== newTask?.completed) changes.push({ action: "completed_status_changed", previous: oldTask?.completed, new: newTask?.completed });
    for (const change of changes) await this._createAuditLog(taskId, projectId, actorId, change.action, change.previous, change.new, change.description);
  }

  async getTasks(project, query, projectRole, userId) {
    const tasks = await this.taskRepository.findWithPopulate({ project: project._id });
    return this._enrichTasksWithComments(tasks, { projectRole, userId });
  }

  async getWorkspaceTasks(workspaceId, userId) {
    const projects = await this.projectRepository.findByWorkspace(workspaceId);
    const projectIds = projects.map((p) => p._id);
    const tasks = await this.taskRepository.findWithPopulate(
      { project: { $in: projectIds }, assignee: userId },
      { dueDate: 1, rank: 1 }
    );
    return this._enrichTasksWithComments(tasks, { projectRole: "member", userId: userId.toString() });
  }

  async createTask(project, body, userId, projectRole) {
    const { identifier } = await this._generateTaskIdentifier(project._id);
    const task = await this.taskRepository.create({ ...body, project: project._id, identifier, author: userId, rank: body.rank ?? Date.now() });
    await this._createAuditLog(task._id, project._id, userId, "task_created", null, null, "created this task");
    getIO()?.to(`project:${project._id}`).emit("task:created", { task: this._toTaskResponse(task, { projectRole, userId: userId.toString() }) });
    return this._toTaskResponse(task, { projectRole, userId: userId.toString() });
  }

  async filterTasks(projectId, query, projectRole, userId) {
    const filter = { project: projectId };
    if (query.columnId) filter.columnId = query.columnId;
    if (query.assignee) filter.assignee = query.assignee;
    if (query.cycleId) filter.cycle = query.cycleId;
    const tasks = await this.taskRepository.findWithPopulate(filter);
    return this._enrichTasksWithComments(tasks, { projectRole, userId });
  }

  async bulkUpdateTasks(project, body, userId, projectRole) {
    const { taskIds, updates } = body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) throw new AppError("taskIds required", 400);
    await this.taskRepository.bulkUpdate(taskIds, updates);
    return { updated: taskIds.length };
  }

  async getTask(task, projectRole, userId) {
    const commentCount = await this.taskCommentRepository.count(task._id);
    return this._toTaskResponse(task, { commentCount, projectRole, userId });
  }

  async updateTask(task, project, updates, userId, projectRole) {
    const oldTask = task.toObject ? task.toObject() : { ...task };
    const updated = await this.taskRepository.updateById(task._id, updates);
    this._trackTaskChanges(task._id, project._id, userId, oldTask, updated, project.taskColumns || []);
    getIO()?.to(`project:${project._id}`).emit("task:updated", { task: this._toTaskResponse(updated, { projectRole, userId: userId.toString() }) });
    return this._toTaskResponse(updated, { projectRole, userId: userId.toString() });
  }

  async deleteTask(task, projectId, userId, projectRole) {
    if (projectRole !== "manager" && task.author?.toString() !== userId.toString()) throw new AppError("Insufficient permissions", 403);
    await this.taskRepository.deleteById(task._id);
    getIO()?.to(`project:${projectId}`).emit("task:deleted", { taskId: task._id });
  }

  async duplicateTask(task, project, userId, projectRole) {
    const { identifier } = await this._generateTaskIdentifier(project._id);
    const raw = task.toObject ? task.toObject() : { ...task };
    const { _id, createdAt, updatedAt, ...rest } = raw;
    const newTask = await this.taskRepository.create({ ...rest, identifier, author: userId, rank: Date.now() });
    return this._toTaskResponse(newTask, { projectRole, userId: userId.toString() });
  }

  getAuditLog(taskId) { return this.taskRepository.findAuditLogs(taskId); }
}





