import { AppError } from "../../../lib/AppError.js";
import { eventBus, Events } from "../../../lib/eventBus.js";

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
    const canWrite = ["owner", "admin", "member"].includes(projectRole);
    const isAuthor = task?.authorId === userId;
    return { canEdit: canWrite, canMove: canWrite, canDuplicate: canWrite, canDelete: ["owner", "admin"].includes(projectRole) || isAuthor };
  }

  _toTaskResponse(task, { commentCount = 0, projectRole = "viewer", userId = "" } = {}) {
    const raw = typeof task.toObject === "function" ? task.toObject() : { ...task };
    const { isOverdue, dueState } = this._getTaskDueState(raw.dueDate);
    const mapped = { ...raw, commentCount, isOverdue, dueState, permissions: this._getTaskPermissions(task, projectRole, userId) };
    if (mapped.assigneeId !== undefined) { mapped.assignee = mapped.assigneeId; delete mapped.assigneeId; }
    if (mapped.authorId !== undefined) { mapped.author = mapped.authorId; delete mapped.authorId; }
    if (mapped.cycleId !== undefined) { mapped.cycle = mapped.cycleId; delete mapped.cycleId; }
    if (mapped.parentTaskId !== undefined) { mapped.parentTask = mapped.parentTaskId; delete mapped.parentTaskId; }
    return mapped;
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
      if (log) {
        eventBus.emit("TASK_ACTIVITY_CREATED", { projectId: String(projectId), payload: { taskId: String(taskId), projectId: String(projectId), action, activityId: log._id.toString(), activity: { _id: log._id.toString(), actor: { _id: String(actorId), name: actor?.name || "User", avatar: actor?.avatar }, action, previous_value: previousValue, new_value: newValue, description: log.description, createdAt: log.createdAt } } });
      }
    } catch (_) { /* non-fatal */ }
  }

  async _trackTaskChanges(taskId, projectId, actorId, oldTask, newTask, projectColumns) {
    const changes = [];
    if (oldTask?.assigneeId !== newTask?.assigneeId) changes.push({ action: oldTask?.assigneeId && !newTask?.assigneeId ? "assignee_removed" : !oldTask?.assigneeId && newTask?.assigneeId ? "assignee_added" : "assignee_changed", previous: oldTask?.assigneeId, new: newTask?.assigneeId });
    if ((oldTask?.columnId || "") !== (newTask?.columnId || "")) {
      const oldCol = projectColumns.find((c) => c.id === oldTask?.columnId)?.title || oldTask?.columnId || "(unknown)";
      const newCol = projectColumns.find((c) => c.id === newTask?.columnId)?.title || newTask?.columnId || "(unknown)";
      changes.push({ action: "column_moved", previous: oldTask?.columnId, new: newTask?.columnId, description: `moved from "${oldCol}" to "${newCol}"` });
    }
    if (oldTask?.dueDate?.toString() !== newTask?.dueDate?.toString()) changes.push({ action: "due_date_changed", previous: oldTask?.dueDate, new: newTask?.dueDate });
    if (oldTask?.completed !== newTask?.completed) changes.push({ action: "completed_status_changed", previous: oldTask?.completed, new: newTask?.completed });
    for (const change of changes) await this._createAuditLog(taskId, projectId, actorId, change.action, change.previous, change.new, change.description);
  }

  async getTasks(project, query, projectRole, userId, pagination = null) {
    const filter = { projectId: project._id.toString() };
    if (query.cycle) filter.cycleId = query.cycle;
    
    const { tasks, total } = await this.taskRepository.findTasksWithCount(filter, null, pagination);
    
    return { tasks: await this._enrichTasksWithComments(tasks, { projectRole, userId }), total };
  }

  async getWorkspaceTasks(workspaceId, userId, pagination = null) {
    const projects = await this.projectRepository.findByWorkspace(workspaceId);
    const projectIds = projects.map((p) => p._id);
    const filter = { projectId: { $in: projectIds.map(String) }, assigneeId: userId.toString() };
    
    const { tasks, total } = await this.taskRepository.findTasksWithCount(filter, { dueDate: 1, rank: 1 }, pagination);
    
    return { tasks: await this._enrichTasksWithComments(tasks, { projectRole: "member", userId: userId.toString() }), total };
  }

  async createTask(project, body, userId, projectRole) {
    const { identifier } = await this._generateTaskIdentifier(project._id);
    const task = await this.taskRepository.create({ ...body, projectId: project._id.toString(), identifier, authorId: userId.toString(), rank: body.rank ?? Date.now() });
    await this._createAuditLog(task._id, project._id, userId, "task_created", null, null, "created this task");
    eventBus.emit(Events.TASK_CREATED, { projectId: project._id.toString(), task: this._toTaskResponse(task, { projectRole, userId: userId.toString() }) });
    return this._toTaskResponse(task, { projectRole, userId: userId.toString() });
  }

  async filterTasks(projectId, query, projectRole, userId, pagination = null) {
    const filter = { projectId: projectId.toString() };
    if (query.columnId) filter.columnId = query.columnId;
    if (query.assignee) filter.assigneeId = query.assignee;
    if (query.cycleId) filter.cycleId = query.cycleId;
    
    const { tasks, total } = await this.taskRepository.findTasksWithCount(filter, null, pagination);
    
    return { tasks: await this._enrichTasksWithComments(tasks, { projectRole, userId }), total };
  }

  async bulkUpdateTasks(project, body, userId, projectRole) {
    const { taskIds, data } = body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) throw new AppError("taskIds required", 400);
    await this.taskRepository.bulkUpdate(taskIds, data);
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
    eventBus.emit(Events.TASK_UPDATED, { projectId: project._id.toString(), task: this._toTaskResponse(updated, { projectRole, userId: userId.toString() }) });
    return this._toTaskResponse(updated, { projectRole, userId: userId.toString() });
  }

  async deleteTask(task, projectId, userId, projectRole) {
    if (!["owner", "admin"].includes(projectRole) && task.authorId !== userId.toString()) throw new AppError("Insufficient permissions", 403);
    await this.taskRepository.deleteById(task._id);
    eventBus.emit(Events.TASK_DELETED, { projectId: projectId.toString(), taskId: task._id.toString() });
  }

  async duplicateTask(task, project, userId, projectRole) {
    const { identifier } = await this._generateTaskIdentifier(project._id);
    const raw = task.toObject ? task.toObject() : { ...task };
    const { _id, createdAt, updatedAt, ...rest } = raw;
    const newTask = await this.taskRepository.create({ ...rest, identifier, authorId: userId.toString(), rank: Date.now() });
    return this._toTaskResponse(newTask, { projectRole, userId: userId.toString() });
  }

  getAuditLog(taskId) { return this.taskRepository.findAuditLogs(taskId); }
}





