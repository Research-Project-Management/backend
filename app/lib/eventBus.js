import { EventEmitter } from "events";
import { getIO } from "../config/socket.js";

class EventBus extends EventEmitter { }

export const eventBus = new EventBus();

eventBus.setMaxListeners(50);

export const Events = {
  // Task
  TASK_CREATED: "TASK_CREATED",
  TASK_UPDATED: "TASK_UPDATED",
  TASK_DELETED: "TASK_DELETED",

  // Cycle
  CYCLE_CREATED: "CYCLE_CREATED",
  CYCLE_UPDATED: "CYCLE_UPDATED",
  CYCLE_DELETED: "CYCLE_DELETED",

  // Workspace
  WORKSPACE_MEMBERS_CHANGED: "WORKSPACE_MEMBERS_CHANGED",
  USER_WORKSPACES_CHANGED: "USER_WORKSPACES_CHANGED",

  // Project
  PROJECT_UPDATED: "PROJECT_UPDATED",
  PROJECT_COLUMN_CREATED: "PROJECT_COLUMN_CREATED",
  PROJECT_COLUMN_UPDATED: "PROJECT_COLUMN_UPDATED",

  // Page
  PAGE_CREATED: "PAGE_CREATED",
  PAGE_UPDATED: "PAGE_UPDATED",
  PAGE_DELETED: "PAGE_DELETED",
  CHILD_PAGE_CREATED: "CHILD_PAGE_CREATED",

  // Comment
  PAGE_COMMENT_CREATED: "PAGE_COMMENT_CREATED",
  PAGE_COMMENT_UPDATED: "PAGE_COMMENT_UPDATED",
  PAGE_COMMENT_DELETED: "PAGE_COMMENT_DELETED",
  PAGE_REPLY_ADDED: "PAGE_REPLY_ADDED",
  PAGE_REPLY_REMOVED: "PAGE_REPLY_REMOVED",

  TASK_COMMENT_CREATED: "TASK_COMMENT_CREATED",
  TASK_COMMENT_UPDATED: "TASK_COMMENT_UPDATED",
  TASK_COMMENT_DELETED: "TASK_COMMENT_DELETED",
  TASK_REPLY_ADDED: "TASK_REPLY_ADDED",
  TASK_REPLY_REMOVED: "TASK_REPLY_REMOVED",
};

export function bindSocketToEventBus() {
  eventBus.on(Events.TASK_CREATED, ({ projectId, task }) => getIO()?.to(`project:${projectId}`).emit("task:created", { task }));
  eventBus.on(Events.TASK_UPDATED, ({ projectId, task }) => getIO()?.to(`project:${projectId}`).emit("task:updated", { task }));
  eventBus.on(Events.TASK_DELETED, ({ projectId, taskId }) => getIO()?.to(`project:${projectId}`).emit("task:deleted", { taskId }));
  eventBus.on("TASK_ACTIVITY_CREATED", ({ projectId, payload }) => getIO()?.to(`project:${projectId}`).emit("task-activity:created", payload));

  eventBus.on(Events.CYCLE_CREATED, ({ projectId, cycle }) => getIO()?.to(`project:${projectId}`).emit("cycle:created", { cycle }));
  eventBus.on(Events.CYCLE_UPDATED, ({ projectId, cycle }) => getIO()?.to(`project:${projectId}`).emit("cycle:updated", { cycle }));
  eventBus.on(Events.CYCLE_DELETED, ({ projectId, cycleId }) => getIO()?.to(`project:${projectId}`).emit("cycle:deleted", { cycleId }));

  eventBus.on(Events.WORKSPACE_MEMBERS_CHANGED, ({ workspaceId, payload }) => getIO()?.to(`workspace:${workspaceId}`).emit("workspace:members-changed", payload));
  eventBus.on(Events.USER_WORKSPACES_CHANGED, ({ affectedUserId, payload }) => getIO()?.to(`user:${affectedUserId}`).emit("user:workspaces-changed", payload));

  eventBus.on(Events.PROJECT_UPDATED, ({ workspaceId, projectId }) => getIO()?.to(`workspace:${workspaceId}`).emit("project:updated", { projectId }));
  eventBus.on(Events.PROJECT_COLUMN_CREATED, ({ projectId, columns }) => getIO()?.to(`project:${projectId}`).emit("column:created", { columns }));
  eventBus.on(Events.PROJECT_COLUMN_UPDATED, ({ projectId, columns }) => getIO()?.to(`project:${projectId}`).emit("column:updated", { columns }));

  eventBus.on(Events.PAGE_CREATED, ({ projectId, page }) => getIO()?.to(`project:${projectId}`).emit("page:created", { page }));
  eventBus.on(Events.PAGE_UPDATED, ({ pageId, page }) => getIO()?.to(`page:${pageId}`).emit("page:updated", { page }));
  eventBus.on(Events.PAGE_DELETED, ({ projectId, pageId }) => getIO()?.to(`project:${projectId}`).emit("page:deleted", { pageId }));
  eventBus.on(Events.CHILD_PAGE_CREATED, ({ parentPageId, file }) => getIO()?.to(`page:${parentPageId}`).emit("file:created", { file }));

  eventBus.on(Events.PAGE_COMMENT_CREATED, ({ pageId, payload }) => getIO()?.to(`page:${pageId}`).emit("comment:created", payload));
  eventBus.on(Events.PAGE_COMMENT_UPDATED, ({ pageId, payload }) => getIO()?.to(`page:${pageId}`).emit("comment:updated", payload));
  eventBus.on(Events.PAGE_COMMENT_DELETED, ({ pageId, payload }) => getIO()?.to(`page:${pageId}`).emit("comment:deleted", payload));
  eventBus.on(Events.PAGE_REPLY_ADDED, ({ pageId, payload }) => getIO()?.to(`page:${pageId}`).emit("reply:added", payload));
  eventBus.on(Events.PAGE_REPLY_REMOVED, ({ pageId, payload }) => getIO()?.to(`page:${pageId}`).emit("reply:removed", payload));

  eventBus.on(Events.TASK_COMMENT_CREATED, ({ projectId, payload }) => getIO()?.to(`project:${projectId}`).emit("task-comment:created", payload));
  eventBus.on(Events.TASK_COMMENT_UPDATED, ({ projectId, payload }) => getIO()?.to(`project:${projectId}`).emit("task-comment:updated", payload));
  eventBus.on(Events.TASK_COMMENT_DELETED, ({ projectId, payload }) => getIO()?.to(`project:${projectId}`).emit("task-comment:deleted", payload));
  eventBus.on(Events.TASK_REPLY_ADDED, ({ projectId, payload }) => getIO()?.to(`project:${projectId}`).emit("task-reply:added", payload));
  eventBus.on(Events.TASK_REPLY_REMOVED, ({ projectId, payload }) => getIO()?.to(`project:${projectId}`).emit("task-reply:removed", payload));
}
