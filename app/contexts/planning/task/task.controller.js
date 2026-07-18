import { asyncHandler } from "../../../lib/asyncHandler.js";
import { getPaginationOptions, buildPaginatedResponse } from "../../../lib/pagination.js";

export class TaskController {
  _mapBody(body) {
    if (!body) return body;
    const res = { ...body };
    if (res.assignee !== undefined) { res.assigneeId = res.assignee; delete res.assignee; }
    if (res.author !== undefined) { res.authorId = res.author; delete res.author; }
    if (res.parentTask !== undefined) { res.parentTaskId = res.parentTask; delete res.parentTask; }
    if (res.cycle !== undefined) { res.cycleId = res.cycle; delete res.cycle; }
    return res;
  }

  constructor({ taskService }) {
    this.taskService = taskService;
    this.getTasks = asyncHandler(async (req, res) => { 
      const pagination = req.query.page ? getPaginationOptions(req) : null;
      const { tasks, total } = await this.taskService.getTasks(req.project, req.query, req.projectRole, req.user._id.toString(), pagination); 
      res.json({
        tasks,
        columns: req.project.taskColumns,
        projectName: req.project.name,
        ...(pagination ? { meta: { total, page: pagination.page, limit: pagination.limit } } : { meta: { total } })
      }); 
    });
    this.getWorkspaceTasks = asyncHandler(async (req, res) => {
      const pagination = req.query.page ? getPaginationOptions(req) : null;
      const { tasks, total } = await this.taskService.getWorkspaceTasks(req.workspace._id, req.user._id.toString(), pagination);
      const response = pagination ? buildPaginatedResponse(tasks, total, pagination.page, pagination.limit) : { data: tasks, meta: { total } };
      res.json(response);
    });
    this.createTask = asyncHandler(async (req, res) => { res.status(201).json({ task: await this.taskService.createTask(req.project, this._mapBody(req.body), req.user._id, req.projectRole) }); });
    this.filterTasks = asyncHandler(async (req, res) => { 
      const pagination = req.query.page ? getPaginationOptions(req) : null;
      const { tasks, total } = await this.taskService.filterTasks(req.project._id, req.query, req.projectRole, req.user._id.toString(), pagination); 
      const response = pagination ? buildPaginatedResponse(tasks, total, pagination.page, pagination.limit) : { data: tasks, meta: { total } };
      res.json(response); 
    });
    this.bulkUpdateTasks = asyncHandler(async (req, res) => { 
      const mappedBody = { ...req.body, data: this._mapBody(req.body.data) };
      res.json(await this.taskService.bulkUpdateTasks(req.project, mappedBody, req.user._id, req.projectRole)); 
    });
    this.getTask = asyncHandler(async (req, res) => { res.json({ task: await this.taskService.getTask(req.task, req.projectRole, req.user._id.toString()) }); });
    this.updateTask = asyncHandler(async (req, res) => { res.json({ task: await this.taskService.updateTask(req.task, req.project, this._mapBody(req.body), req.user._id, req.projectRole) }); });
    this.deleteTask = asyncHandler(async (req, res) => { await this.taskService.deleteTask(req.task, req.project._id, req.user._id, req.projectRole); res.status(204).end(); });
    this.duplicateTask = asyncHandler(async (req, res) => { res.status(201).json({ task: await this.taskService.duplicateTask(req.task, req.project, req.user._id, req.projectRole) }); });
    this.assignTask = asyncHandler(async (req, res) => { res.json({ task: await this.taskService.updateTask(req.task, req.project, this._mapBody(req.body), req.user._id, req.projectRole) }); });
    this.reorderTask = asyncHandler(async (req, res) => { res.json(await this.taskService.bulkUpdateTasks(req.project, req.body, req.user._id, req.projectRole)); });
    this.getAuditLog = asyncHandler(async (req, res) => { res.json({ activity: await this.taskService.getAuditLog(req.task._id) }); });
  }
}



