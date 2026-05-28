/**
 * taskHelpers.js — Pure helper functions extracted from task.js
 *
 * All functions here are stateless (no Express req/res) so they are easy to
 * unit-test independently of the HTTP layer.
 */

import UserModel from "../schema/user.js";
import TaskModel from "../schema/task.js";
import TaskCommentModel from "../schema/taskComment.js";
import AuditLogModel from "../schema/auditLog.js";
import ProjectModel from "../schema/project.js";
import CycleModel from "../schema/cycle.js";
import { getIO } from "../libs/socket.js";

// ─── Due-date helpers ────────────────────────────────────────────────────────

/**
 * Classify a task's due date relative to today.
 * @returns {{ isOverdue: boolean, dueState: "none"|"overdue"|"onTime" }}
 */
export function getTaskDueState(dueDateValue) {
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

// ─── Permission helpers ──────────────────────────────────────────────────────

/**
 * Compute per-task permissions for a given project role + user.
 */
export function getTaskPermissions(task, projectRole, userId) {
  const canWrite = projectRole === "manager" || projectRole === "member";
  const isAuthor = task?.author?.toString?.() === userId;

  return {
    canEdit: canWrite,
    canMove: canWrite,
    canDuplicate: canWrite,
    canDelete: projectRole === "manager" || isAuthor,
  };
}

/**
 * Shape a lean task object into the standard API response shape.
 * Works with both Mongoose Documents (calls .toObject()) and plain objects (from .lean()).
 */
export function toTaskResponse(
  task,
  { commentCount = 0, projectRole = "viewer", userId = "" } = {},
) {
  const raw = typeof task.toObject === "function" ? task.toObject() : task;
  const { isOverdue, dueState } = getTaskDueState(raw.dueDate);

  return {
    ...raw,
    commentCount,
    isOverdue,
    dueState,
    permissions: getTaskPermissions(task, projectRole, userId),
  };
}

// ─── Fetch helper ────────────────────────────────────────────────────────────

/**
 * Fetch tasks matching `query`, attach comment counts + permissions, and
 * return the shaped array.
 *
 * Replaces the 30-line copy-pasted block that appeared in three GET handlers.
 *
 * @param {object}  query       - Mongoose filter (e.g. { project: projectId })
 * @param {object}  populateOpts - Extra populate paths appended to the defaults
 * @param {string}  projectRole - Role string for permission shaping
 * @param {string}  userId      - Requesting user's _id (string)
 * @param {object}  sortOpts    - Mongoose sort (default: { rank: 1 })
 * @returns {Promise<object[]>}
 */
export async function fetchTasksWithComments(
  query,
  { projectRole = "viewer", userId = "", sort = { rank: 1 }, extraPopulate = [] } = {},
) {
  const basePopulate = [
    { path: "assignee", select: "name avatar" },
    { path: "cycle",   select: "name phase status" },
    { path: "parentTask", select: "title identifier" },
    ...extraPopulate,
  ];

  let q = TaskModel.find(query).sort(sort);
  for (const pop of basePopulate) {
    q = q.populate(pop);
  }
  const tasks = await q.lean();

  const taskIds = tasks.map((t) => t._id);
  const commentCounts = await TaskCommentModel.aggregate([
    { $match: { task: { $in: taskIds } } },
    { $group: { _id: "$task", count: { $sum: 1 } } },
  ]);
  const commentCountMap = new Map(
    commentCounts.map((item) => [item._id.toString(), item.count]),
  );

  return tasks.map((task) => {
    const { isOverdue, dueState } = getTaskDueState(task.dueDate);
    return {
      ...task,
      commentCount: commentCountMap.get(task._id.toString()) || 0,
      isOverdue,
      dueState,
      permissions: getTaskPermissions(task, projectRole, userId),
    };
  });
}

// ─── Identifier generator ────────────────────────────────────────────────────

/**
 * Atomically increment a project's taskSequence and return a formatted
 * identifier string like "PROJ-42".
 *
 * The first call for a project whose taskSequence is 0 will scan existing
 * tasks and set the counter to the current maximum before incrementing —
 * this is the migration guard that used to be inlined in the CREATE handler.
 *
 * @param {string} projectId
 * @returns {Promise<{ identifier: string, projectDoc: object }>}
 */
export async function generateTaskIdentifier(projectId) {
  // MIGRATION: If taskSequence is 0, initialize it from existing tasks.
  let project = await ProjectModel.findById(projectId);
  if (project && project.taskSequence === 0) {
    const existingTasks = await TaskModel.find({ project: projectId }, "identifier");
    const maxSeq = existingTasks.reduce((max, t) => {
      const parts = (t.identifier || "").split("-");
      const seq = parseInt(parts[parts.length - 1], 10);
      return Number.isNaN(seq) ? max : Math.max(max, seq);
    }, 0);

    project = await ProjectModel.findByIdAndUpdate(
      projectId,
      { $set: { taskSequence: maxSeq } },
      { new: true },
    );
  }

  const projectDoc = await ProjectModel.findByIdAndUpdate(
    projectId,
    { $inc: { taskSequence: 1 } },
    { new: true },
  );

  const prefix = (projectDoc.name || "TASK")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
  const identifier = `${prefix}-${projectDoc.taskSequence}`;

  return { identifier, projectDoc };
}

// ─── Audit log helpers ───────────────────────────────────────────────────────

export async function createAuditLog(
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
        name: actor?.name || "User",
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
  } catch (_) {
    // Ignore audit log failures so task operations still succeed.
  }
}

export function getActionDescription(action, previousValue, newValue) {
  const actionLabels = {
    task_created: "created this task",
    assignee_added:
      previousValue && newValue
        ? `added ${formatUserValue(newValue)} to this card`
        : "added a member to this card",
    assignee_removed: previousValue
      ? `removed ${formatUserValue(previousValue)} from this card`
      : "removed a member from this card",
    assignee_changed: "updated the assignee",
    column_moved: "moved column",
    attachments_changed: "updated attachments",
    due_date_changed:
      previousValue && newValue
        ? `changed the due date of this card to ${formatDateWithTime(newValue)}`
        : newValue
          ? `set the due date for this card to ${formatDateWithTime(newValue)}`
          : "removed the due date",
    completed_status_changed: newValue
      ? "marked this card as complete"
      : "marked this card as incomplete",
    checklist_changed: getChecklistDescription(previousValue, newValue),
  };

  return actionLabels[action] || "Updated";
}

export function formatUserValue(value) {
  if (!value) return "user";
  if (typeof value === "object" && value.name) {
    return value.name;
  }
  const id = normalizeId(value);
  return id || "user";
}

export function getChecklistDescription(previousValue, newValue) {
  const previousTitles = Array.isArray(previousValue) ? previousValue : [];
  const newTitles = Array.isArray(newValue) ? newValue : [];

  const addedTitle = newTitles.find((title) => !previousTitles.includes(title));
  if (addedTitle) {
    return `added checklist "${addedTitle}"`;
  }

  const removedTitle = previousTitles.find((title) => !newTitles.includes(title));
  if (removedTitle) {
    return `removed checklist "${removedTitle}"`;
  }

  return "updated the checklist";
}

export function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value._id) return value._id.toString();
    if (typeof value.toString === "function") return value.toString();
  }
  return String(value);
}

export async function resolveUserName(value, cache) {
  if (!value) return "";

  if (typeof value === "object" && value.name) {
    return value.name;
  }

  const id = normalizeId(value);
  if (!id) return "";
  if (cache.has(id)) return cache.get(id);

  const user = await UserModel.findById(id).select("name").lean();
  const name = user?.name || "User";
  cache.set(id, name);
  return name;
}

export function resolveColumnName(columnId, projectColumns = []) {
  const id = normalizeId(columnId);
  if (!id) return "";

  const found = projectColumns.find(
    (col) => normalizeId(col?.id) === id || normalizeId(col?._id) === id,
  );

  return found?.title || id;
}

export function buildAttachmentKey(file) {
  return file?.id || file?.url || file?.name || "";
}

export function getAttachmentDiff(previousValue = [], newValue = []) {
  const oldMap = new Map(
    (previousValue || []).map((file) => [buildAttachmentKey(file), file]),
  );
  const newMap = new Map(
    (newValue || []).map((file) => [buildAttachmentKey(file), file]),
  );

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

export function formatDateWithTime(date) {
  if (!date) return "";
  const d = new Date(date);
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month} at ${hours}:${minutes}`;
}

export async function trackTaskChanges(
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
    let description = "updated the assignee";
    if (!oldName && newName) {
      action = "assignee_added";
      description = `added ${newName} to this card`;
    } else if (oldName && !newName) {
      action = "assignee_removed";
      description = `removed ${oldName} from this card`;
    } else if (oldName && newName && oldName !== newName) {
      description = `changed the assignee from ${oldName} to ${newName}`;
    }

    changes.push({
      action,
      previous: oldTask?.assignee,
      new: newTask?.assignee,
      description,
    });
  }

  if ((oldTask?.columnId || "") !== (newTask?.columnId || "")) {
    const oldColumn = resolveColumnName(oldTask?.columnId, projectColumns) || "(unknown)";
    const newColumn = resolveColumnName(newTask?.columnId, projectColumns) || "(unknown)";

    changes.push({
      action: "column_moved",
      previous: oldTask?.columnId,
      new: newTask?.columnId,
      description: `moved this card from column "${oldColumn}" to column "${newColumn}"`,
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
      const addedNames = added
        .map((file) => file?.name)
        .filter(Boolean)
        .join(", ");
      changes.push({
        action: "attachments_changed",
        previous: null,
        new: added,
        description: `attached file ${addedNames}`,
      });
    }

    if (removed.length) {
      const removedNames = removed
        .map((file) => file?.name)
        .filter(Boolean)
        .join(", ");
      changes.push({
        action: "attachments_changed",
        previous: removed,
        new: null,
        description: `removed attachment ${removedNames}`,
      });
    }
  }

  const oldChecklistTitles = (oldTask?.checklists || [])
    .map((item) => item?.title?.trim())
    .filter(Boolean);
  const newChecklistTitles = (newTask?.checklists || [])
    .map((item) => item?.title?.trim())
    .filter(Boolean);
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
