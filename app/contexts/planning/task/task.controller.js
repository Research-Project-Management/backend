import { asyncHandler } from "../../../lib/asyncHandler.js";

export class TaskController {
  constructor({ taskService }) {
    this.taskService = taskService;
    this.getTasks = asyncHandler(async (req, res) => { 
      res.json({ 
        tasks: await this.taskService.getTasks(req.project, req.query, req.projectRole, req.user._id.toString()),
        columns: req.project.taskColumns,
        projectName: req.project.name
      }); 
    });
    this.getWorkspaceTasks = asyncHandler(async (req, res) => {
      res.json({
        tasks: await this.taskService.getWorkspaceTasks(req.workspace._id, req.user._id.toString())
      });
    });
    this.createTask = asyncHandler(async (req, res) => { res.status(201).json({ task: await this.taskService.createTask(req.project, req.body, req.user._id, req.projectRole) }); });
    this.filterTasks = asyncHandler(async (req, res) => { res.json({ tasks: await this.taskService.filterTasks(req.project._id, req.query, req.projectRole, req.user._id.toString()) }); });
    this.bulkUpdateTasks = asyncHandler(async (req, res) => { res.json(await this.taskService.bulkUpdateTasks(req.project, req.body, req.user._id, req.projectRole)); });
    this.getTask = asyncHandler(async (req, res) => { res.json({ task: await this.taskService.getTask(req.task, req.projectRole, req.user._id.toString()) }); });
    this.updateTask = asyncHandler(async (req, res) => { res.json({ task: await this.taskService.updateTask(req.task, req.project, req.body, req.user._id, req.projectRole) }); });
    this.deleteTask = asyncHandler(async (req, res) => { await this.taskService.deleteTask(req.task, req.project._id, req.user._id, req.projectRole); res.status(204).end(); });
    this.duplicateTask = asyncHandler(async (req, res) => { res.status(201).json({ task: await this.taskService.duplicateTask(req.task, req.project, req.user._id, req.projectRole) }); });
    this.assignTask = asyncHandler(async (req, res) => { res.json({ task: await this.taskService.updateTask(req.task, req.project, req.body, req.user._id, req.projectRole) }); });
    this.reorderTask = asyncHandler(async (req, res) => { res.json(await this.taskService.bulkUpdateTasks(req.project, req.body, req.user._id, req.projectRole)); });
    this.getAuditLog = asyncHandler(async (req, res) => { res.json({ logs: await this.taskService.getAuditLog(req.task._id) }); });
  }
}



