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

// List cycles for a project (with task stats)
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

    const cyclesWithStats = await Promise.all(
      cycles.map(async (cycle) => {
        const tasks = await TaskModel.find({
          project: projectId,
          cycle: cycle._id,
        }).select("columnId");

        const totalTasks = tasks.length;
        const project = req.project;
        const doneColumns = (project.taskColumns || [])
          .filter(
            (col) =>
              col.title?.toLowerCase() === "done" ||
              col.title?.toLowerCase() === "completed",
          )
          .map((col) => col.id);

        const completedTasks = tasks.filter((t) =>
          doneColumns.includes(t.columnId),
        ).length;

        const progress =
          totalTasks > 0
            ? Math.round((completedTasks / totalTasks) * 100)
            : 0;

        return {
          ...cycle.toObject(),
          stats: { totalTasks, completedTasks, progress },
        };
      }),
    );

    res.json({ cycles: cyclesWithStats });
  }),
);

// Create cycle
cycleRouter.post(
  "/project/:projectId/cycles",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    const { name, description, startDate, endDate, phase, milestones, deliverables } = req.body;

    const count = await CycleModel.countDocuments({ project: projectId });

    const cycle = new CycleModel({
      name,
      description,
      project: projectId,
      startDate,
      endDate,
      phase: phase || "custom",
      milestones: milestones || [],
      deliverables: deliverables || [],
      order: count,
      author: req.user._id,
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
      const updated = await CycleModel.findByIdAndUpdate(cycleId, updateData, { new: true })
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
