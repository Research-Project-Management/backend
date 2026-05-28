import mongoose from "mongoose";
import { Router } from "express";
import TaskModel from "../schema/task.js";
import TaskCommentModel from "../schema/taskComment.js";
import AuditLogModel from "../schema/auditLog.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import UserModel from "../schema/user.js";
import {
  isAuthenticated,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";
import { checkTaskRole } from "../middleware/checkTaskRole.js";
import { getIO } from "../libs/socket.js";
import {
  getTaskDueState,
  getTaskPermissions,
  toTaskResponse,
  fetchTasksWithComments,
  generateTaskIdentifier,
  createAuditLog,
  trackTaskChanges,
} from "../helpers/taskHelpers.js";

const taskRouter = Router();


// Get Tasks and Columns

taskRouter.get(
  "/project/:projectId/tasks",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { projectId } = req.params;
      const { cycle } = req.query;

      const query = { project: projectId };
      if (cycle) query.cycle = cycle;

      const tasks = await fetchTasksWithComments(query, {
        projectRole: req.projectRole,
        userId: req.user._id.toString(),
      });

      const project = req.project;
      res.json({ tasks, columns: project.taskColumns, projectName: project.name });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);


// Get All Tasks in Workspace
taskRouter.get(
  "/workspace/:workspaceId/tasks",
  isAuthenticated,
  async (req, res) => {
    try {
      const { workspaceId } = req.params;

      const isObjectId = workspaceId.match(/^[0-9a-fA-F]{24}$/);
      const workspace = isObjectId
        ? await WorkspaceModel.findById(workspaceId).select("_id members").lean()
        : await WorkspaceModel.findOne({ url: workspaceId }).select("_id members").lean();

      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const isMember = workspace.members.some(
        (m) => m.user && m.user.toString() === req.user._id.toString(),
      );
      if (!isMember) return res.status(403).json({ error: "Access denied" });

      const projectIds = await ProjectModel.find({ workspace: workspace._id })
        .select("_id")
        .lean()
        .then((docs) => docs.map((d) => d._id));

      const tasks = await fetchTasksWithComments(
        { project: { $in: projectIds }, assignee: req.user._id },
        {
          projectRole: "member",
          userId: req.user._id.toString(),
          sort: { dueDate: 1, rank: 1 },
          extraPopulate: [{ path: "project", select: "name avatar" }],
        },
      );

      res.json({ tasks });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);


// Create Task
async function createTaskHandler(req, res) {
  try {
    const {
      title, columnId, content, description, assignee,
      startDate, dueDate, recurrence, reminder,
      labels, priority, estimate, cycle, parentTask,
    } = req.body;
    const { projectId } = req.params;

    if (!title?.trim()) return res.status(400).json({ error: "title is required" });
    if (!columnId)      return res.status(400).json({ error: "columnId is required" });

    const hasColumn = req.project?.taskColumns?.some(
      (col) => col.id === columnId || col._id?.toString() === columnId,
    );
    if (!hasColumn) return res.status(400).json({ error: "Invalid columnId" });

    if (cycle) {
      const targetCycle = await mongoose.model("Cycle").findById(cycle);
      if (targetCycle) {
        if (targetCycle.status === "completed")
          return res.status(400).json({ message: "Cannot add tasks to a completed cycle." });
        if (targetCycle.project.toString() !== projectId)
          return res.status(400).json({ message: "Cycle does not belong to this project." });
      }
    }

    const count = await TaskModel.countDocuments({ project: projectId, columnId });
    const { identifier } = await generateTaskIdentifier(projectId);

    const newTask = new TaskModel({
      title, content, description, columnId,
      project: projectId,
      assignee: assignee || null,
      startDate, dueDate,
      recurrence: recurrence || "none",
      reminder: reminder || "1day",
      labels,
      priority: priority || "none",
      estimate,
      cycle: cycle || null,
      parentTask: parentTask || null,
      identifier,
      rank: count + 1,
      author: req.user._id,
    });

    await newTask.save();
    await newTask.populate("assignee", "name avatar");
    await newTask.populate("cycle", "name phase status");
    await newTask.populate("parentTask", "title identifier");

    await createAuditLog(newTask._id, projectId, req.user._id, "task_created", null, null, "Created this task");

    const responseTask = toTaskResponse(newTask, {
      commentCount: 0,
      projectRole: req.projectRole,
      userId: req.user._id.toString(),
    });

    getIO()?.to(`project:${projectId}`).emit("task:created", { task: responseTask });
    res.status(201).json({ task: responseTask });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

taskRouter.post(
  "/project/:projectId/tasks",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  createTaskHandler,
);



taskRouter.get(
  "/tasks/:taskId",
  isAuthenticated,
  checkTaskRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const task = await TaskModel.findById(taskId)
        .populate("assignee", "name avatar")
        .populate("cycle", "name phase status")
        .populate("parentTask", "title identifier");
      if (!task) return res.status(404).json({ error: "Task not found" });

      const commentCount = await TaskCommentModel.countDocuments({ task: taskId });
      res.json({
        task: toTaskResponse(task, {
          commentCount,
          projectRole: req.projectRole,
          userId: req.user._id.toString(),
        }),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

taskRouter.post(
  "/tasks/:taskId/duplicate",
  isAuthenticated,
  checkTaskRole("manager", "member"),
  async (req, res) => {
    try {
      const sourceTask = await TaskModel.findById(req.params.taskId);
      if (!sourceTask) return res.status(404).json({ error: "Task not found" });

      const totalInColumn = await TaskModel.countDocuments({
        project: sourceTask.project,
        columnId: sourceTask.columnId,
      });

      // Auto-generate identifier using atomic counter
      const projectDoc = await ProjectModel.findByIdAndUpdate(
        sourceTask.project,
        { $inc: { taskSequence: 1 } },
        { new: true }
      );

      const prefix = (projectDoc.name || "TASK")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
      const identifier = `${prefix}-${projectDoc.taskSequence}`;

      const duplicatedTask = new TaskModel({
        title: `${sourceTask.title} (copy)`,
        content: sourceTask.content,
        description: sourceTask.description,
        project: sourceTask.project,
        columnId: sourceTask.columnId,
        assignee: sourceTask.assignee || null,
        dueDate: sourceTask.dueDate,
        labels: sourceTask.labels,
        priority: sourceTask.priority,
        estimate: sourceTask.estimate,
        cycle: sourceTask.cycle || null,
        parentTask: sourceTask.parentTask || null,
        startDate: sourceTask.startDate,
        recurrence: sourceTask.recurrence || "none",
        reminder: sourceTask.reminder || "1day",
        checklists: sourceTask.checklists || [],
        completed: false,
        attachments: sourceTask.attachments || [],
        identifier,
        rank: totalInColumn + 1,
        author: req.user._id,
      });

      await duplicatedTask.save();
      await duplicatedTask.populate("assignee", "name avatar");
      await duplicatedTask.populate("cycle", "name phase status");
      await duplicatedTask.populate("parentTask", "title identifier");

      const responseTask = toTaskResponse(duplicatedTask, {
        commentCount: 0,
        projectRole: req.projectRole,
        userId: req.user._id.toString(),
      });

      getIO()
        ?.to(`project:${sourceTask.project}`)
        .emit("task:created", { task: responseTask });

      res.status(201).json({ task: responseTask });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Update Task
taskRouter.put(
  "/tasks/:taskId",
  isAuthenticated,
  checkTaskRole("manager", "member"),
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const allowedFields = [
        "title",
        "content",
        "description",
        "columnId",
        "assignee",
        "startDate",
        "dueDate",
        "recurrence",
        "reminder",
        "labels",
        "priority",
        "estimate",
        "cycle",
        "parentTask",
        "rank",
        "checklists",
        "completed",
        "attachments",
      ];

      const updateData = Object.fromEntries(
        Object.entries(req.body).filter(([key]) => allowedFields.includes(key)),
      );

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      if (typeof updateData.title === "string" && !updateData.title.trim()) {
        return res.status(400).json({ error: "title cannot be empty" });
      }

      if (updateData.columnId) {
        const hasColumn = req.project?.taskColumns?.some(
          (col) => col.id === updateData.columnId || col._id?.toString() === updateData.columnId,
        );
        if (!hasColumn) {
          return res.status(400).json({ error: "Invalid columnId" });
        }
      }

      if (updateData.cycle) {
        const targetCycle = await mongoose.model("Cycle").findById(updateData.cycle);
        if (targetCycle) {
          const task = await TaskModel.findById(taskId);
          if (targetCycle.project.toString() !== task.project.toString()) {
            return res.status(400).json({ error: "Cycle does not belong to this project." });
          }
          if (targetCycle.status === "completed") {
             return res.status(400).json({ error: "Cannot move tasks to a completed cycle." });
          }
        }
      }

      // Fetch old task for audit tracking
      const oldTask = await TaskModel.findById(taskId).populate("cycle");
      if (!oldTask) return res.status(404).json({ error: "Task not found" });

      // Block updates if cycle is completed (Allow column moves and ranking)
      if (oldTask.cycle && oldTask.cycle.status === "completed") {
        const sensitiveFields = ["title", "content", "description", "assignee", "startDate", "dueDate", "recurrence", "reminder", "labels", "priority", "estimate", "checklists", "attachments"];
        const isModifyingSensitive = Object.keys(updateData).some(key => sensitiveFields.includes(key));
        
        if (isModifyingSensitive) {
          return res.status(400).json({ message: "Completed cycles are read-only." });
        }
      }

      const updatedTask = await TaskModel.findByIdAndUpdate(
        taskId,
        updateData,
        { new: true },
      )
        .populate("assignee", "name avatar")
        .populate("cycle", "name phase status")
        .populate("parentTask", "title identifier");

      // Track changes in audit log
      await trackTaskChanges(
        taskId,
        updatedTask.project,
        req.user._id,
        oldTask,
        updatedTask,
        req.project?.taskColumns || [],
      );

      const commentCount = await TaskCommentModel.countDocuments({ task: taskId });
      const responseTask = toTaskResponse(updatedTask, {
        commentCount,
        projectRole: req.projectRole,
        userId: req.user._id.toString(),
      });

      getIO()
        ?.to(`project:${updatedTask.project}`)
        .emit("task:updated", { task: responseTask });
      res.json({ task: responseTask });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Bulk Update Tasks
const bulkUpdateTasksHandler = async (req, res) => {
  try {
    const { taskIds, data: updateData } = req.body;
    const { projectId } = req.params;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: "taskIds must be a non-empty array" });
    }

    const allowedFields = ["cycle", "columnId", "completed", "priority", "assignee", "startDate", "dueDate", "labels", "estimate"];
    const filteredUpdate = Object.fromEntries(
      Object.entries(updateData).filter(([key]) => allowedFields.includes(key)),
    );

    if (Object.keys(filteredUpdate).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    // Check cycle isolation and status if cycle is being updated
    if (filteredUpdate.cycle) {
      const targetCycle = await mongoose.model("Cycle").findById(filteredUpdate.cycle);
      if (!targetCycle || targetCycle.project.toString() !== projectId) {
        return res.status(400).json({ error: "Invalid cycle for this project." });
      }
      if (targetCycle.status === "completed") {
        return res.status(400).json({ error: "Cannot move tasks to a completed cycle." });
      }
    }

    // Fetch tasks to check their current cycle status
    const tasksToUpdate = await TaskModel.find({
      _id: { $in: taskIds },
      project: projectId,
    }).populate("cycle");

    const validTaskIds = [];
    const sensitiveFields = ["priority", "title", "content", "description"]; // Fields blocked in completed cycles

    for (const task of tasksToUpdate) {
      if (task.cycle && task.cycle.status === "completed") {
        const isModifyingSensitive = Object.keys(filteredUpdate).some((key) => sensitiveFields.includes(key));
        if (isModifyingSensitive) continue;
      }
      validTaskIds.push(task._id);
    }

    if (validTaskIds.length === 0) {
      return res.status(400).json({ message: "No tasks could be updated (some may belong to completed cycles)." });
    }

    // Update tasks in bulk
    await TaskModel.updateMany(
      { _id: { $in: validTaskIds }, project: projectId },
      { $set: filteredUpdate },
    );

    // Fetch updated tasks to emit events
    const updatedTasks = await TaskModel.find({
      _id: { $in: validTaskIds },
      project: projectId,
    })
      .populate("assignee", "name avatar")
      .populate("cycle", "name phase status")
      .populate("parentTask", "title identifier")
      .lean();

    const project = await ProjectModel.findById(projectId);
    const defaultColumnId = project?.taskColumns?.[0]?.id;

    const io = getIO();
    if (io) {
      for (const task of updatedTasks) {
        if (!task.columnId && defaultColumnId) {
          await TaskModel.findByIdAndUpdate(task._id, { columnId: defaultColumnId });
          task.columnId = defaultColumnId;
        }

        const { isOverdue, dueState } = getTaskDueState(task.dueDate);
        const responseTask = {
          ...task,
          isOverdue,
          dueState,
          permissions: getTaskPermissions(task, req.projectRole, req.user._id.toString()),
        };
        io.to(`project:${projectId}`).emit("task:updated", { task: responseTask });
      }
    }

    res.json({ success: true, count: updatedTasks.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

taskRouter.put(
  "/project/:projectId/tasks/bulk",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  bulkUpdateTasksHandler,
);

// Get Task Activity Logs
taskRouter.get(
  "/tasks/:taskId/activity",
  isAuthenticated,
  checkTaskRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { taskId } = req.params;

      const logs = await AuditLogModel.find({ task: taskId })
        .populate("actor", "name avatar")
        .sort({ createdAt: -1 })
        .limit(100);

      res.json({ activity: logs });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Delete Task
taskRouter.delete(
  "/tasks/:taskId",
  isAuthenticated,
  checkTaskRole("manager", "member"),
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const task = await TaskModel.findById(taskId).populate("cycle");
      if (!task) return res.status(404).json({ error: "Task not found" });

      if (task.cycle && task.cycle.status === "completed") {
        return res.status(400).json({ message: "Completed cycles are read-only." });
      }

      const projectId = task.project.toString();
      await TaskCommentModel.deleteMany({ task: taskId });
      await TaskModel.findByIdAndDelete(taskId);

      getIO()
        ?.to(`project:${projectId}`)
        .emit("task:deleted", { taskId, projectId });

      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

async function createColumnHandler(req, res) {
  try {
    const { title, accentColor } = req.body;
    const { projectId } = req.params;

    // Fetch the actual document to use .save()
    const project = await ProjectModel.findById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const newColumn = {
      id: `col-${Date.now()}`,
      title,
      accentColor: accentColor || "#e2e8f0",
    };

    project.taskColumns.push(newColumn);
    await project.save();
    
    const { clearProjectCache } = await import("../middleware/checkWorkspaceRole.js");
    await clearProjectCache(req.params.projectId);

    getIO()
      ?.to(`project:${req.params.projectId}`)
      .emit("column:created", { columns: project.taskColumns });
    res.json({ columns: project.taskColumns });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function updateColumnHandler(req, res) {
  try {
    const { projectId, columnId } = req.params;
    const { title, accentColor } = req.body;
    
    // Fetch the actual document to use .save()
    const project = await ProjectModel.findById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const column = project.taskColumns.find(
      (c) => c.id === columnId || c._id?.toString() === columnId,
    );
    if (!column) return res.status(404).json({ error: "Column not found" });

    // Không còn chặn sửa column nào

    if (title) column.title = title;
    if (accentColor) column.accentColor = accentColor;

    await project.save();
    const { clearProjectCache } = await import("../middleware/checkWorkspaceRole.js");
    await clearProjectCache(projectId);

    getIO()?.to(`project:${projectId}`).emit("column:updated", {
      columns: project.taskColumns,
    });

    res.json({ columns: project.taskColumns });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function deleteColumnHandler(req, res) {
  try {
    const { projectId, columnId } = req.params;
    
    // Fetch the actual document to use .save()
    const project = await ProjectModel.findById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const columnIndex = project.taskColumns.findIndex(
      (c) => c.id === columnId || c._id?.toString() === columnId,
    );
    if (columnIndex === -1) {
      return res.status(404).json({ error: "Column not found" });
    }

    // Delete all tasks belonging to this column
    await TaskModel.deleteMany({ project: projectId, columnId: columnId });

    // Remove column from list
    project.taskColumns.splice(columnIndex, 1);
    await project.save();
    
    const { clearProjectCache } = await import("../middleware/checkWorkspaceRole.js");
    await clearProjectCache(projectId);

    getIO()?.to(`project:${projectId}`).emit("column:updated", {
      columns: project.taskColumns,
    });

    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Create Column
taskRouter.post(
  "/project/:projectId/columns",
  isAuthenticated,
  checkProjectRole("manager"),
  createColumnHandler,
);

// Update Column
taskRouter.put(
  "/project/:projectId/columns/:columnId",
  isAuthenticated,
  checkProjectRole("manager"),
  updateColumnHandler,
);

// Delete Column
taskRouter.delete(
  "/project/:projectId/columns/:columnId",
  isAuthenticated,
  checkProjectRole("manager"),
  deleteColumnHandler,
);

export default taskRouter;