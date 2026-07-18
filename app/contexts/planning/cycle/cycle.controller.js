import { AppError } from "../../../lib/AppError.js";
import { asyncHandler } from "../../../lib/asyncHandler.js";

export class CycleController {
  constructor({ cycleService }) {
    this.cycleService = cycleService;
    this.getCycles = asyncHandler(async (req, res) => { res.json({ cycles: await this.cycleService.getCycles(req.params.projectId) }); });
    this.createCycle = asyncHandler(async (req, res) => { res.status(201).json({ cycle: await this.cycleService.createCycle(req.params.projectId, req.body, req.user._id) }); });
    this.getCycle = asyncHandler(async (req, res) => { const c = await this.cycleService.getCycle(req.params.cycleId); if (!c) throw new AppError("Cycle not found", 404); res.json({ cycle: c }); });
    this.updateCycle = asyncHandler(async (req, res) => { res.json({ cycle: await this.cycleService.updateCycle(req.params.cycleId, req.body, req.project?._id, req.user._id) }); });
    this.deleteCycle = asyncHandler(async (req, res) => { await this.cycleService.deleteCycle(req.params.cycleId, req.project?._id); res.status(204).end(); });
    this.addTask = asyncHandler(async (req, res) => { res.json(await this.cycleService.addTask(req.params.cycleId, req.body.taskId)); });
    this.removeTask = asyncHandler(async (req, res) => { res.json(await this.cycleService.removeTask(req.params.cycleId, req.params.taskId)); });
  }
}



