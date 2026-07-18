import { AppError } from "../../../lib/AppError.js";
import { eventBus, Events } from "../../../lib/eventBus.js";

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
        const q = { projectId: projectId, status: "active" };
        if (excludeId) q._id = { $ne: excludeId };
        const active = await this.cycleRepository.findOne(q);
        if (active) throw new AppError(`"${active.name}" is already active`, 400);
      }
    }
  }

  getCycles(projectId) { return this.cycleRepository.findByProject(projectId); }
  getCycle(cycleId) { return this.cycleRepository.findById(cycleId); }

  async createCycle(projectId, data, userId) {
    await this._validateCycle(projectId, data.status, data.startDate, data.endDate);
    const cycle = await this.cycleRepository.create({ ...data, projectId: projectId, authorId: userId });
    eventBus.emit(Events.CYCLE_CREATED, { projectId: projectId.toString(), cycle });
    return cycle;
  }

  async updateCycle(cycleId, data, projectId, userId) {
    // Merge existing cycle dates with updates so status-only changes don't fail validation
    const existing = await this.cycleRepository.findById(cycleId);
    const mergedStartDate = data.startDate !== undefined ? data.startDate : existing?.startDate;
    const mergedEndDate = data.endDate !== undefined ? data.endDate : existing?.endDate;
    await this._validateCycle(projectId, data.status ?? existing?.status, mergedStartDate, mergedEndDate, cycleId);
    const cycle = await this.cycleRepository.updateById(cycleId, data);
    eventBus.emit(Events.CYCLE_UPDATED, { projectId: projectId.toString(), cycle });
    return cycle;
  }

  async deleteCycle(cycleId, projectId) {
    await this.cycleRepository.deleteById(cycleId);
    eventBus.emit(Events.CYCLE_DELETED, { projectId: projectId.toString(), cycleId: cycleId.toString() });
  }

  async addTask(cycleId, taskId) {
    const cycle = await this.cycleRepository.findById(cycleId);
    if (!cycle) throw new AppError("Cycle not found", 404);
    const task = await this.taskRepository.updateById(taskId, { cycleId: cycleId });
    if (!task) throw new AppError("Task not found", 404);
    return { cycle };
  }

  async removeTask(cycleId, taskId) {
    const cycle = await this.cycleRepository.findById(cycleId);
    if (!cycle) throw new AppError("Cycle not found", 404);
    const task = await this.taskRepository.findById(taskId);
    if (task && task.cycleId === cycleId) {
      await this.taskRepository.updateById(taskId, { cycleId: null });
    }
    return { cycle };
  }
}





