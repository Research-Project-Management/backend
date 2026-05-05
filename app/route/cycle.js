import { Router } from "express";
import CycleModel from "../schema/cycle.js";
import TaskModel from "../schema/task.js";
import {
  isAuthenticated,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";
import { asyncHandler } from "../middleware/helpers.js";
import { getIO } from "../libs/socket.js";

const cycleRouter = Router();

import ProjectModel from "../schema/project.js";

/**
 * Derives the effective status of a cycle.
 */
const validateCycle = async (projectId, targetStatus, startDate, endDate, excludeId = null) => {
  const project = await ProjectModel.findById(projectId);
  if (!project) return { valid: false, error: "Project not found." };

  const parallelEnabled = project.settings?.parallelCycles === true;

  // 1. Basic Date Validation
  if (startDate && endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (s > e) {
      return { valid: false, error: "Start date cannot be after end date." };
    }
  }

  // 2. Active Cycle Requirements
  if (targetStatus === "active") {
    if (!startDate || !endDate) {
      return { valid: false, error: "Active cycles must have both start and end dates." };
    }

    // Parallel check for multiple active
    if (!parallelEnabled) {
      const activeCycle = await CycleModel.findOne({ 
        project: projectId, 
        status: "active",
        _id: { $ne: excludeId } 
      });
      
      if (activeCycle) {
        return { valid: false, error: `"${activeCycle.name}" is already active.` };
      }
    }
  }

  // 3. Overlap Validation (if Parallel is OFF)
  if (!parallelEnabled && startDate && endDate) {
    const s = new Date(startDate); s.setHours(0, 0, 0, 0);
    const e = new Date(endDate); e.setHours(0, 0, 0, 0);

    const overlappingCycle = await CycleModel.findOne({
      project: projectId,
      _id: { $ne: excludeId },
      status: { $ne: "completed" }, // Exclude completed cycles from overlap validation
      startDate: { $lte: e.toISOString() },
      endDate: { $gte: s.toISOString() }
    });

    if (overlappingCycle) {
      return { valid: false, error: `Dates overlap with "${overlappingCycle.name}".` };
    }
  }

  return { valid: true };
};

// List cycles for a project
cycleRouter.get(
  "/project/:projectId/cycles",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;

    const cycles = await CycleModel.find({ project: projectId })
      .populate("author", "name avatar")
      .populate("deliverables.fileId", "filename url")
      .sort({ order: 1, createdAt: 1 });

    // AUTO-COMPLETION LOGIC: Check for cycles that should be closed based on date
    const now = new Date();
    let hasChanges = false;

    for (const cycle of cycles) {
      if (cycle.status !== "completed" && cycle.endDate) {
        const endDate = new Date(cycle.endDate);
        // Set to end of day (23:59:59.999) to avoid early closing
        endDate.setHours(23, 59, 59, 999);
        
        if (now > endDate) {
          // AUTO CLOSE
          cycle.status = "completed";
          cycle.ended_at = now;

          // SNAPSHOT STATS
          const tasks = await TaskModel.find({ cycle: cycle._id });
          const totalTasks = tasks.length;
          const completedTasks = tasks.filter(t => t.completed).length;
          const completionPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
          
          cycle.statsAtCompletion = {
            totalTasks,
            completedTasks,
            completionPercentage
          };
          
          await cycle.save();
          hasChanges = true;
        }
      }
    }

    res.json({ cycles });
  }),
);

// Create cycle
cycleRouter.post(
  "/project/:projectId/cycles",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    const { name, description, startDate, endDate, phase, milestones, deliverables, labels, status } = req.body;

    const validation = await validateCycle(projectId, status, startDate, endDate);
    if (!validation.valid) {
      return res.status(400).json({ message: validation.error });
    }

    const count = await CycleModel.countDocuments({ project: projectId });

    const cycle = new CycleModel({
      name,
      description,
      project: projectId,
      startDate,
      endDate,
      status: status || "planned",
      phase: phase || "topic_selection",
      milestones: milestones || [],
      deliverables: deliverables || [],
      labels: labels || [],
      order: count,
      author: req.user._id,
      started_at: (status === "active") ? new Date() : null,
    });

    await cycle.save();
    await cycle.populate("author", "name avatar");

    getIO()?.to(`project:${projectId}`).emit("cycle:created", { cycle });
    res.status(201).json({ cycle });
  }),
);

// Update cycle
cycleRouter.put(
  "/cycles/:cycleId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { cycleId } = req.params;
    const cycle = await CycleModel.findById(cycleId);
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });

    // Set projectId for role checking
    req.params.projectId = cycle.project.toString();
    await checkProjectRole("manager", "member")(req, res, async () => {
      const updateData = req.body;
      const now = new Date();

      // 1. Validation Logic (Strict Rules)
      const needsValidation = 
        (updateData.status && updateData.status !== cycle.status) || 
        (updateData.startDate !== undefined && updateData.startDate !== cycle.startDate) ||
        (updateData.endDate !== undefined && updateData.endDate !== cycle.endDate);

      if (needsValidation) {
        // Block reopening completed cycles
        if (updateData.status && cycle.status === "completed" && updateData.status !== "completed") {
          return res.status(400).json({ message: "Completed cycles cannot be reopened." });
        }

        const targetStatus = updateData.status || cycle.status;
        const targetStart = updateData.startDate || cycle.startDate;
        const targetEnd = updateData.endDate || cycle.endDate;

        const validation = await validateCycle(cycle.project, targetStatus, targetStart, targetEnd, cycleId);
        if (!validation.valid) {
          return res.status(400).json({ message: validation.error });
        }
      }

      // 2. State Transition Timestamps
      if (updateData.status && updateData.status !== cycle.status) {
        if (updateData.status === "active") {
          updateData.started_at = now;
        } else if (updateData.status === "completed") {
          updateData.ended_at = now;
          
          // SNAPSHOT STATS
          const tasks = await TaskModel.find({ cycle: cycleId });
          const totalTasks = tasks.length;
          const completedTasks = tasks.filter(t => t.completed).length;
          const completionPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
          
          updateData.statsAtCompletion = {
            totalTasks,
            completedTasks,
            completionPercentage
          };
        }
      }

      const updated = await CycleModel.findByIdAndUpdate(cycleId, { $set: updateData }, { new: true })
        .populate("author", "name avatar")
        .populate("deliverables.fileId", "filename url");

      getIO()?.to(`project:${cycle.project}`).emit("cycle:updated", { cycle: updated });
      res.json({ cycle: updated });
    });
  }),
);

// Delete cycle
cycleRouter.delete(
  "/cycles/:cycleId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { cycleId } = req.params;
    const cycle = await CycleModel.findById(cycleId);
    if (!cycle) return res.status(404).json({ error: "Cycle not found" });

    const projectId = cycle.project.toString();

    // Check authorization before deleting
    req.params.projectId = projectId;
    await checkProjectRole("manager", "member")(req, res, async () => {
      // Unlink tasks from this cycle
      await TaskModel.updateMany(
        { cycle: cycleId },
        { $set: { cycle: null } },
      );

      await CycleModel.findByIdAndDelete(cycleId);

      getIO()?.to(`project:${projectId}`).emit("cycle:deleted", { cycleId, projectId });
      res.status(204).end();
    });
  }),
);

export default cycleRouter;
