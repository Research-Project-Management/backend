import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { checkCycleRole } from "../../../middleware/cycle.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateCycleDto, UpdateCycleDto, AddCycleTaskDto } from "./cycle.dto.js";

export const buildCycleRouter = (cycleController) => {
  const cycleRouter = Router();

  // Project-context cycle routes
  cycleRouter.get("/project/:projectId/cycles", isAuthenticated, checkProjectRole("owner", "admin", "member", "viewer"), cycleController.getCycles);
  cycleRouter.post("/project/:projectId/cycles", isAuthenticated, checkProjectRole("owner", "admin", "member"), validate(CreateCycleDto), cycleController.createCycle);
  cycleRouter.get("/project/:projectId/cycles/:cycleId", isAuthenticated, checkCycleRole("owner", "admin", "member", "viewer"), cycleController.getCycle);
  cycleRouter.put("/project/:projectId/cycles/:cycleId", isAuthenticated, checkCycleRole("owner", "admin", "member"), validate(UpdateCycleDto), cycleController.updateCycle);
  cycleRouter.delete("/project/:projectId/cycles/:cycleId", isAuthenticated, checkCycleRole("owner", "admin"), cycleController.deleteCycle);
  cycleRouter.post("/project/:projectId/cycles/:cycleId/tasks", isAuthenticated, checkCycleRole("owner", "admin", "member"), validate(AddCycleTaskDto), cycleController.addTask);
  cycleRouter.delete("/project/:projectId/cycles/:cycleId/tasks/:taskId", isAuthenticated, checkCycleRole("owner", "admin", "member"), cycleController.removeTask);

  // Global-context cycle routes (alias paths mapped from frontend queries)
  cycleRouter.get("/cycles/:cycleId", isAuthenticated, checkCycleRole("owner", "admin", "member", "viewer"), cycleController.getCycle);
  cycleRouter.put("/cycles/:cycleId", isAuthenticated, checkCycleRole("owner", "admin", "member"), validate(UpdateCycleDto), cycleController.updateCycle);
  cycleRouter.delete("/cycles/:cycleId", isAuthenticated, checkCycleRole("owner", "admin"), cycleController.deleteCycle);
  cycleRouter.post("/cycles/:cycleId/tasks", isAuthenticated, checkCycleRole("owner", "admin", "member"), validate(AddCycleTaskDto), cycleController.addTask);
  cycleRouter.delete("/cycles/:cycleId/tasks/:taskId", isAuthenticated, checkCycleRole("owner", "admin", "member"), cycleController.removeTask);

  return cycleRouter;
}

