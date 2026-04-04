import mongoose from "mongoose";
import { Router } from "express";
import TaskModel from "../schema/task.js";
import TaskCommentModel from "../schema/taskComment.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import UserModel from "../schema/user.js";
import {
  isAuthenticated,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";
import { checkTaskRole } from "../middleware/checkTaskRole.js";
import { getIO } from "../libs/socket.js";

const taskRouter = Router();

const auditLogSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
      index: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      enum: [
        "task_created",
        "assignee_added",
        "assignee_removed",
        "assignee_changed",
        "column_moved",
        "attachments_changed",
        "due_date_changed",
        "completed_status_changed",
        "checklist_changed",
      ],
      required: true,
    },
    previous_value: mongoose.Schema.Types.Mixed,
    new_value: mongoose.Schema.Types.Mixed,
    description: String,
  },
  {
    timestamps: true,
  },
);

auditLogSchema.index({ task: 1, createdAt: -1 });
auditLogSchema.index({ project: 1, createdAt: -1 });

const AuditLogModel =
  mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);

function getTaskDueState(dueDateValue) {
  if (!dueDateValue) {
    return { isOverdue: false, dueState: "none" };
  }

  const dueDate = new Date(dueDateValue);
  if (Number.isNaN(dueDate.getTime())) {
    return { isOverdue: false, dueState: "none" };
  }

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const isOverdue = dueDate.getTime() < endOfToday.getTime();
  return { isOverdue, dueState: isOverdue ? "overdue" : "onTime" };
}

function getTaskPermissions(task, projectRole, userId) {
  const canWrite = projectRole === "manager" || projectRole === "member";
  const isAuthor = task?.author?.toString?.() === userId;

  return {
    canEdit: canWrite,
    canMove: canWrite,
    canDuplicate: canWrite,
    canDelete: projectRole === "manager" || isAuthor,
  };
}

function toTaskResponse(task, { commentCount = 0, projectRole = "viewer", userId = "" } = {}) {
  const raw = task.toObject();
  const { isOverdue, dueState } = getTaskDueState(raw.dueDate);

  return {
    ...raw,
    commentCount,
    isOverdue,
    dueState,
    permissions: getTaskPermissions(task, projectRole, userId),
  };
}

async function createAuditLog(
  taskId,
  projectId,
  actorId,
  action,
  previousValue,
  newValue,
  description,
) {
  try {
    const log = await AuditLogModel.create({
      task: taskId,
      project: projectId,
      actor: actorId,
      action,
      previous_value: previousValue,
      new_value: newValue,
      description: description || getActionDescription(action, previousValue, newValue),
    });
    const actor = await UserModel.findById(actorId).select("name avatar").lean();
    const activity = {
      _id: log._id.toString(),
      task: String(taskId),
      project: String(projectId),
      actor: {
        _id: String(actorId),
        name: actor?.name || "Người dùng",
        avatar: actor?.avatar,
      },
      action,
      previous_value: previousValue,
      new_value: newValue,
      description: log.description,
      createdAt: log.createdAt,
      updatedAt: log.updatedAt,
    };
    getIO()?.to(`project:${projectId}`).emit("task-activity:created", {
      taskId: String(taskId),
      projectId: String(projectId),
      action,
      activityId: log._id.toString(),
      activity,
    });
  } catch (error) {
    // Ignore audit log failures so task operations still succeed.
  }
}

function getActionDescription(action, previousValue, newValue) {
  const actionLabels = {
    task_created: "đã tạo tác vụ này",
    assignee_added: previousValue && newValue ? `đã thêm ${formatUserValue(newValue)} vào thẻ này` : "đã thêm thành viên vào thẻ này",
    assignee_removed: previousValue ? `đã loại ${formatUserValue(previousValue)} khỏi thẻ này` : "đã gỡ thành viên khỏi thẻ này",
    assignee_changed: "đã cập nhật thành viên phụ trách",
    column_moved: "đã chuyển cột",
    attachments_changed: "đã cập nhật file đính kèm",
    due_date_changed: previousValue && newValue 
      ? `đã chuyển ngày hết hạn thẻ này sang ${formatDateWithTime(newValue)}`
      : newValue
      ? `đã đặt ngày hết hạn cho thẻ này là ${formatDateWithTime(newValue)}`
      : "đã xóa ngày hết hạn",
    completed_status_changed: newValue
      ? "đã đánh dấu thẻ này là hoàn tất"
      : "đã đánh dấu thẻ này là chưa hoàn tất",
    checklist_changed: getChecklistDescription(previousValue, newValue),
  };

  return actionLabels[action] || "Đã cập nhật";
}

function formatUserValue(value) {
  if (!value) return "người dùng";
  if (typeof value === "object" && value.name) {
    return value.name;
  }

  const id = normalizeId(value);
  return id || "người dùng";
}

function getChecklistDescription(previousValue, newValue) {
  const previousTitles = Array.isArray(previousValue) ? previousValue : [];
  const newTitles = Array.isArray(newValue) ? newValue : [];

  const addedTitle = newTitles.find((title) => !previousTitles.includes(title));
  if (addedTitle) {
    return `đã thêm danh sách công việc "${addedTitle}"`;
  }

  const removedTitle = previousTitles.find((title) => !newTitles.includes(title));
  if (removedTitle) {
    return `đã xóa danh sách công việc "${removedTitle}"`;
  }

  return "đã cập nhật danh sách việc cần làm";
}

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value._id) return value._id.toString();
    if (typeof value.toString === "function") return value.toString();
  }
  return String(value);
}

async function resolveUserName(value, cache) {
  if (!value) return "";

  if (typeof value === "object" && value.name) {
    return value.name;
  }

  const id = normalizeId(value);
  if (!id) return "";
  if (cache.has(id)) return cache.get(id);

  const user = await UserModel.findById(id).select("name").lean();
  const name = user?.name || "Người dùng";
  cache.set(id, name);
  return name;
}

function resolveColumnName(columnId, projectColumns = []) {
  const id = normalizeId(columnId);
  if (!id) return "";

  const found = projectColumns.find(
    (col) => normalizeId(col?.id) === id || normalizeId(col?._id) === id,
  );

  return found?.title || id;
}

function buildAttachmentKey(file) {
  return file?.id || file?.url || file?.name || "";
}

function getAttachmentDiff(previousValue = [], newValue = []) {
  const oldMap = new Map((previousValue || []).map((file) => [buildAttachmentKey(file), file]));
  const newMap = new Map((newValue || []).map((file) => [buildAttachmentKey(file), file]));

  const added = [];
  const removed = [];

  for (const [key, file] of newMap) {
    if (!oldMap.has(key)) added.push(file);
  }

  for (const [key, file] of oldMap) {
    if (!newMap.has(key)) removed.push(file);
  }

  return { added, removed };
}

function formatDateWithTime(date) {
  if (!date) return "";
  const d = new Date(date);
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day} tháng ${month} lúc ${hours}:${minutes}`;
}

async function trackTaskChanges(
  taskId,
  projectId,
  actorId,
  oldTask,
  newTask,
  projectColumns = [],
) {
  const changes = [];
  const userNameCache = new Map();
  if (oldTask?.assignee?.toString() !== newTask?.assignee?.toString()) {
    const oldName = await resolveUserName(oldTask?.assignee, userNameCache);
    const newName = await resolveUserName(newTask?.assignee, userNameCache);

    let action = "assignee_changed";
    let description = "đã cập nhật thành viên phụ trách";
    if (!oldName && newName) {
      action = "assignee_added";
      description = `đã thêm ${newName} vào thẻ này`;
    } else if (oldName && !newName) {
      action = "assignee_removed";
      description = `đã loại ${oldName} khỏi thẻ này`;
    } else if (oldName && newName && oldName !== newName) {
      description = `đã thay đổi thành viên phụ trách từ ${oldName} sang ${newName}`;
    }

    changes.push({
      action,
      previous: oldTask?.assignee,
      new: newTask?.assignee,
      description,
    });
  }

  if ((oldTask?.columnId || "") !== (newTask?.columnId || "")) {
    const oldColumn = resolveColumnName(oldTask?.columnId, projectColumns) || "(không xác định)";
    const newColumn = resolveColumnName(newTask?.columnId, projectColumns) || "(không xác định)";

    changes.push({
      action: "column_moved",
      previous: oldTask?.columnId,
      new: newTask?.columnId,
      description: `đã chuyển thẻ này từ cột "${oldColumn}" sang cột "${newColumn}"`,
    });
  }

  if (oldTask?.dueDate?.toString() !== newTask?.dueDate?.toString()) {
    changes.push({
      action: "due_date_changed",
      previous: oldTask?.dueDate,
      new: newTask?.dueDate,
    });
  }

  if (oldTask?.completed !== newTask?.completed) {
    changes.push({
      action: "completed_status_changed",
      previous: oldTask?.completed,
      new: newTask?.completed,
    });
  }

  const oldAttachments = oldTask?.attachments || [];
  const newAttachments = newTask?.attachments || [];
  const { added, removed } = getAttachmentDiff(oldAttachments, newAttachments);
  if (added.length || removed.length) {
    if (added.length) {
      const addedNames = added.map((file) => file?.name).filter(Boolean).join(", ");
      changes.push({
        action: "attachments_changed",
        previous: null,
        new: added,
        description: `đã đính kèm file ${addedNames}`,
      });
    }

    if (removed.length) {
      const removedNames = removed.map((file) => file?.name).filter(Boolean).join(", ");
      changes.push({
        action: "attachments_changed",
        previous: removed,
        new: null,
        description: `đã xóa file đính kèm ${removedNames}`,
      });
    }
  }

  const oldChecklistTitles = (oldTask?.checklists || []).map((item) => item?.title?.trim()).filter(Boolean);
  const newChecklistTitles = (newTask?.checklists || []).map((item) => item?.title?.trim()).filter(Boolean);
  const oldChecklistSignature = JSON.stringify(oldChecklistTitles);
  const newChecklistSignature = JSON.stringify(newChecklistTitles);
  if (oldChecklistSignature !== newChecklistSignature) {
    changes.push({
      action: "checklist_changed",
      previous: oldChecklistTitles,
      new: newChecklistTitles,
    });
  }

  for (const change of changes) {
    await createAuditLog(
      taskId,
      projectId,
      actorId,
      change.action,
      change.previous,
      change.new,
      change.description,
    );
  }
}

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

      const tasks = await TaskModel.find(query)
        .populate("assignee", "name avatar")
        .populate("cycle", "name phase status")
        .populate("parentTask", "title identifier")
        .sort({ rank: 1 });

      const taskIds = tasks.map((task) => task._id);
      const commentCounts = await TaskCommentModel.aggregate([
        { $match: { task: { $in: taskIds } } },
        { $group: { _id: "$task", count: { $sum: 1 } } },
      ]);
      const commentCountMap = new Map(
        commentCounts.map((item) => [item._id.toString(), item.count]),
      );
      const tasksWithCommentCount = tasks.map((task) =>
        toTaskResponse(task, {
          commentCount: commentCountMap.get(task._id.toString()) || 0,
          projectRole: req.projectRole,
          userId: req.user._id.toString(),
        }),
      );

      const project =
        await ProjectModel.findById(projectId).select("taskColumns name");
      if (!project) return res.status(404).json({ error: "Project not found" });

      res.json({
        tasks: tasksWithCommentCount,
        columns: project.taskColumns,
        projectName: project.name,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

taskRouter.get(
  "/projects/:projectId/tasks",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { projectId } = req.params;
      const { cycle } = req.query;

      const query = { project: projectId };
      if (cycle) query.cycle = cycle;

      const tasks = await TaskModel.find(query)
        .populate("assignee", "name avatar")
        .populate("cycle", "name phase status")
        .populate("parentTask", "title identifier")
        .sort({ rank: 1 });

      const taskIds = tasks.map((task) => task._id);
      const commentCounts = await TaskCommentModel.aggregate([
        { $match: { task: { $in: taskIds } } },
        { $group: { _id: "$task", count: { $sum: 1 } } },
      ]);
      const commentCountMap = new Map(
        commentCounts.map((item) => [item._id.toString(), item.count]),
      );
      const tasksWithCommentCount = tasks.map((task) =>
        toTaskResponse(task, {
          commentCount: commentCountMap.get(task._id.toString()) || 0,
          projectRole: req.projectRole,
          userId: req.user._id.toString(),
        }),
      );

      const project =
        await ProjectModel.findById(projectId).select("taskColumns name");
      if (!project) return res.status(404).json({ error: "Project not found" });

      res.json({
        tasks: tasksWithCommentCount,
        columns: project.taskColumns,
        projectName: project.name,
      });
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

      // Check if user has access to workspace (find by URL)
      const workspace = await WorkspaceModel.findOne({ url: workspaceId });
      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (!workspaceMember) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Get all projects in workspace
      const projects = await ProjectModel.find({ workspace: workspace._id });
      const projectIds = projects.map((p) => p._id);

      // Get all tasks from these projects
      const tasks = await TaskModel.find({
        project: { $in: projectIds },
        assignee: req.user._id, // Only get tasks assigned to current user
      })
        .populate("assignee", "name avatar")
        .populate({
          path: "project",
          select: "name emoji",
        })
        .sort({ createdAt: -1 });

      const taskIds = tasks.map((task) => task._id);
      const commentCounts = await TaskCommentModel.aggregate([
        { $match: { task: { $in: taskIds } } },
        { $group: { _id: "$task", count: { $sum: 1 } } },
      ]);
      const commentCountMap = new Map(
        commentCounts.map((item) => [item._id.toString(), item.count]),
      );
      const tasksWithCommentCount = tasks.map((task) =>
        toTaskResponse(task, {
          commentCount: commentCountMap.get(task._id.toString()) || 0,
          projectRole: "member",
          userId: req.user._id.toString(),
        }),
      );

      res.json({ tasks: tasksWithCommentCount });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Create Task
taskRouter.post(
  "/project/:projectId/tasks",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  async (req, res) => {
    try {
      const {
        title,
        columnId,
        content,
        description,
        assignee,
        startDate,
        dueDate,
        recurrence,
        reminder,
        labels,
        priority,
        estimate,
        cycle,
        parentTask,
      } = req.body;
      const { projectId } = req.params;

      if (!title?.trim()) {
        return res.status(400).json({ error: "title is required" });
      }
      if (!columnId) {
        return res.status(400).json({ error: "columnId is required" });
      }

      const hasColumn = req.project?.taskColumns?.some(
        (col) => col.id === columnId || col._id?.toString() === columnId,
      );
      if (!hasColumn) {
        return res.status(400).json({ error: "Invalid columnId" });
      }

      const count = await TaskModel.countDocuments({
        project: projectId,
        columnId,
      });

      // Auto-generate identifier
      const project = req.project;
      const prefix = (project.name || "TASK")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
      const totalInProject = await TaskModel.countDocuments({ project: projectId });
      const identifier = `${prefix}-${totalInProject + 1}`;

      const newTask = new TaskModel({
        title,
        content,
        description,
        columnId,
        project: projectId,
        assignee,
        startDate,
        dueDate,
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

      await createAuditLog(
        newTask._id,
        projectId,
        req.user._id,
        "task_created",
        null,
        null,
        "Đã tạo tác vụ này",
      );

      const responseTask = toTaskResponse(newTask, {
        commentCount: 0,
        projectRole: req.projectRole,
        userId: req.user._id.toString(),
      });

      getIO()
        ?.to(`project:${projectId}`)
        .emit("task:created", { task: responseTask });
      res.status(201).json({ task: responseTask });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

taskRouter.post(
  "/projects/:projectId/tasks",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  async (req, res) => {
    try {
      const {
        title,
        columnId,
        content,
        description,
        assignee,
        startDate,
        dueDate,
        recurrence,
        reminder,
        labels,
        priority,
        estimate,
        cycle,
        parentTask,
      } = req.body;
      const { projectId } = req.params;

      if (!title?.trim()) {
        return res.status(400).json({ error: "title is required" });
      }
      if (!columnId) {
        return res.status(400).json({ error: "columnId is required" });
      }

      const hasColumn = req.project?.taskColumns?.some(
        (col) => col.id === columnId || col._id?.toString() === columnId,
      );
      if (!hasColumn) {
        return res.status(400).json({ error: "Invalid columnId" });
      }

      const count = await TaskModel.countDocuments({
        project: projectId,
        columnId,
      });

      const project = req.project;
      const prefix = (project.name || "TASK")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
      const totalInProject = await TaskModel.countDocuments({ project: projectId });
      const identifier = `${prefix}-${totalInProject + 1}`;

      const newTask = new TaskModel({
        title,
        content,
        description,
        columnId,
        project: projectId,
        assignee,
        startDate,
        dueDate,
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

      await createAuditLog(
        newTask._id,
        projectId,
        req.user._id,
        "task_created",
        null,
        null,
        "Đã tạo tác vụ này",
      );

      const responseTask = toTaskResponse(newTask, {
        commentCount: 0,
        projectRole: req.projectRole,
        userId: req.user._id.toString(),
      });

      getIO()
        ?.to(`project:${projectId}`)
        .emit("task:created", { task: responseTask });
      res.status(201).json({ task: responseTask });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
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

      const project = req.project;
      const prefix = (project.name || "TASK")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
      const totalInProject = await TaskModel.countDocuments({ project: sourceTask.project });
      const identifier = `${prefix}-${totalInProject + 1}`;

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

      // Fetch old task for audit tracking
      const oldTask = await TaskModel.findById(taskId);
      if (!oldTask) return res.status(404).json({ error: "Task not found" });

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
      const task = await TaskModel.findById(taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });

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
    const { title, accentColor, isDefault } = req.body;
    const project = req.project;

    const newColumn = {
      id: `col-${Date.now()}`,
      title,
      isDefault: !!isDefault,
      accentColor: accentColor || "#e2e8f0",
    };

    project.taskColumns.push(newColumn);
    await project.save();

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
    const project = req.project;

    const column = project.taskColumns.find(
      (c) => c.id === columnId || c._id?.toString() === columnId,
    );
    if (!column) return res.status(404).json({ error: "Column not found" });

    if (column.isDefault || !column.id.startsWith("col-")) {
      return res.status(403).json({ error: "Default columns cannot be renamed" });
    }

    if (title) column.title = title;
    if (accentColor) column.accentColor = accentColor;

    await project.save();

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
    const project = req.project;

    const columnIndex = project.taskColumns.findIndex(
      (c) => c.id === columnId || c._id?.toString() === columnId,
    );
    if (columnIndex === -1) {
      return res.status(404).json({ error: "Column not found" });
    }

    const column = project.taskColumns[columnIndex];
    if (column.isDefault || !column.id.startsWith("col-")) {
      return res.status(403).json({ error: "Default columns cannot be deleted" });
    }

    project.taskColumns.splice(columnIndex, 1);
    await project.save();

    // If there are tasks in this column, move them to the default column (todo)
    await TaskModel.updateMany(
      { project: projectId, columnId: columnId },
      { columnId: "todo" },
    );

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

taskRouter.post(
  "/projects/:projectId/columns",
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

taskRouter.put(
  "/projects/:projectId/columns/:columnId",
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

taskRouter.delete(
  "/projects/:projectId/columns/:columnId",
  isAuthenticated,
  checkProjectRole("manager"),
  deleteColumnHandler,
);

export default taskRouter;
