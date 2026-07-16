import { getIO } from "../../../config/socket.js";
import { AppError } from "../../../lib/AppError.js";

export class CycleService {
  constructor({ cycleRepository, projectRepository, taskRepository }) {
    this.cycleRepository = cycleRepository;
    this.projectRepository = projectRepository;
    this.taskRepository = taskRepository;
  }

  async _validateCycle(projectId, targetStatus, startDate, endDate, excludeId = null) {
    const project = await this.projectRepository.findById(projectId);
    if (!project) throw new AppError("Project not found", 404);
    if (startDate && endDate && new Date(startDate) > new Date(endDate)) throw new AppError("Start date cannot be after end date", 400);
    if (targetStatus === "active") {
      if (!startDate || !endDate) throw new AppError("Active cycles must have both start and end dates", 400);
      if (!project.settings?.parallelCycles) {
        const q = { project: projectId, status: "active" };
        if (excludeId) q._id = { $ne: excludeId };
        const active = await this.cycleRepository.findOne ? this.cycleRepository.findOne(q) : null;
        if (active) throw new AppError(`"${active.name}" is already active`, 400);
      }
    }
  }

  getCycles(projectId) { return this.cycleRepository.findByProject(projectId); }
  getCycle(cycleId) { return this.cycleRepository.findById(cycleId); }

  async createCycle(projectId, data, userId) {
    await this._validateCycle(projectId, data.status, data.startDate, data.endDate);
    const cycle = await this.cycleRepository.create({ ...data, project: projectId, createdBy: userId });
    getIO()?.to(`project:${projectId}`).emit("cycle:created", { cycle });
    return cycle;
  }

  async updateCycle(cycleId, data, projectId, userId) {
    await this._validateCycle(projectId, data.status, data.startDate, data.endDate, cycleId);
    const cycle = await this.cycleRepository.updateById(cycleId, data);
    getIO()?.to(`project:${projectId}`).emit("cycle:updated", { cycle });
    return cycle;
  }

  deleteCycle(cycleId) { return this.cycleRepository.deleteById(cycleId); }

  async addTask(cycleId, taskId) {
    const cycle = await this.cycleRepository.findById(cycleId);
    if (!cycle) throw new AppError("Cycle not found", 404);
    const task = await this.taskRepository.updateById(taskId, { cycle: cycleId });
    if (!task) throw new AppError("Task not found", 404);
    return { cycle };
  }

  async removeTask(cycleId, taskId) {
    const cycle = await this.cycleRepository.findById(cycleId);
    if (!cycle) throw new AppError("Cycle not found", 404);
    const task = await this.taskRepository.findById(taskId);
    if (task && task.cycle?._id?.toString() === cycleId) {
      await this.taskRepository.updateById(taskId, { cycle: null });
    }
    return { cycle };
  }
}





