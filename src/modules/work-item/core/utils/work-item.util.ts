import { TaskPriority } from '@prisma/client';

export const PRIORITY_MAP: Record<string, TaskPriority> = {
  none: TaskPriority.none,
  low: TaskPriority.low,
  medium: TaskPriority.medium,
  high: TaskPriority.high,
  urgent: TaskPriority.urgent,
};

export const mapPriority = (priority?: string): TaskPriority => {
  return priority
    ? PRIORITY_MAP[priority] || TaskPriority.none
    : TaskPriority.none;
};

import { WorkItemResponse, TaskResponse, LabelMinimal } from '../types/work-item.types';

export { WorkItemResponse, TaskResponse };

const resolveLabels = (taskRecord: any): LabelMinimal[] => {
  if (Array.isArray(taskRecord.resolvedLabels) && taskRecord.resolvedLabels.length > 0) {
    return taskRecord.resolvedLabels.map((labelItem: any) => ({
      id: labelItem.id || labelItem,
      name: labelItem.name || labelItem,
      color: labelItem.color || '#64748b',
    }));
  }

  const raw = taskRecord.labels;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  return raw.map((labelItem: any) => {
    if (typeof labelItem === 'string') {
      // Legacy: plain string (name or ID)
      return { id: labelItem, name: labelItem, color: '#64748b' };
    }
    // Already an object with id/name/color
    return {
      id: labelItem.id || labelItem.name || '',
      name: labelItem.name || labelItem.id || '',
      color: labelItem.color || '#64748b',
    };
  });
};

export const formatWorkItem = (taskRecord: any): WorkItemResponse | null => {
  if (!taskRecord) return null;

  const assignee = taskRecord.assignee
    ? {
      id: taskRecord.assignee.id,
      name: taskRecord.assignee.name,
      email: taskRecord.assignee.email,
      avatar: taskRecord.assignee.avatar,
    }
    : null;

  const cycle = taskRecord.cycle
    ? {
      id: taskRecord.cycle.id,
      name: taskRecord.cycle.name,
    }
    : taskRecord.cycleId || null;

  const isCompleted = taskRecord.columnId === 'done';

  const subtasks = Array.isArray(taskRecord.subtasks)
    ? taskRecord.subtasks.map((subtaskRecord: any) => ({
      ...subtaskRecord,
      id: subtaskRecord.id,
      completed:
        subtaskRecord.columnId === 'done' || Boolean(subtaskRecord.completed),
    }))
    : [];

  const subtaskCount = subtasks.length;
  const subtaskCompletedCount = subtasks.filter(
    (subtaskRecord: any) => subtaskRecord.completed,
  ).length;

  const labels = resolveLabels(taskRecord);

  return {
    ...taskRecord,
    id: taskRecord.id,
    identifier: taskRecord.identifier || null,
    sequenceNumber: taskRecord.sequenceNumber || null,
    description: taskRecord.content || '',
    content: taskRecord.content || '',
    assignee,
    cycle,
    completed:
      taskRecord.completed !== undefined
        ? Boolean(taskRecord.completed)
        : isCompleted,
    relations: taskRecord.relations || [],
    labels,
    subtasks,
    subtaskCount,
    subtaskCompletedCount,
    createdAt: taskRecord.createdAt?.toISOString?.() || taskRecord.createdAt,
    updatedAt: taskRecord.updatedAt?.toISOString?.() || taskRecord.updatedAt,
    startDate:
      taskRecord.startDate?.toISOString?.() || taskRecord.startDate || null,
    dueDate: taskRecord.dueDate?.toISOString?.() || taskRecord.dueDate || null,
  };
};

export const formatTask = formatWorkItem;

export const deriveProjectIdentifierPrefix = (
  rawIdentifier?: string | null,
  rawName?: string | null,
): string => {
  const prefix = rawIdentifier?.trim().toUpperCase();
  if (prefix) return prefix;

  const name = rawName || 'TASK';
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim();

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0]) {
    return words[0].slice(0, 4).toUpperCase();
  } else if (words.length > 1) {
    return words
      .slice(0, 4)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
  }
  return 'TASK';
};
