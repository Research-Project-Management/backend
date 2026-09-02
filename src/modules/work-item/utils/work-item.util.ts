import { TaskPriority, TaskRecurrence, TaskReminder } from '@prisma/client';

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

export const RECURRENCE_MAP: Record<string, TaskRecurrence> = {
  none: TaskRecurrence.none,
  daily: TaskRecurrence.daily,
  'mon-fri': TaskRecurrence.mon_fri,
  mon_fri: TaskRecurrence.mon_fri,
  weekly: TaskRecurrence.weekly,
  'monthly-day': TaskRecurrence.monthly_day,
  monthly_day: TaskRecurrence.monthly_day,
  'monthly-week': TaskRecurrence.monthly_week,
  monthly_week: TaskRecurrence.monthly_week,
};

export const mapRecurrence = (rec?: string): TaskRecurrence => {
  return rec && RECURRENCE_MAP[rec] ? RECURRENCE_MAP[rec] : TaskRecurrence.none;
};

export const REMINDER_MAP: Record<string, TaskReminder> = {
  none: TaskReminder.none,
  'at-time': TaskReminder.at_time,
  at_time: TaskReminder.at_time,
  '5m': TaskReminder.m5,
  m5: TaskReminder.m5,
  '10m': TaskReminder.m10,
  m10: TaskReminder.m10,
  '15m': TaskReminder.m15,
  m15: TaskReminder.m15,
  '1h': TaskReminder.h1,
  h1: TaskReminder.h1,
  '2h': TaskReminder.h2,
  h2: TaskReminder.h2,
  '1day': TaskReminder.d1,
  d1: TaskReminder.d1,
  '2day': TaskReminder.d2,
  d2: TaskReminder.d2,
};

export const mapReminder = (rem?: string): TaskReminder => {
  return rem && REMINDER_MAP[rem] ? REMINDER_MAP[rem] : TaskReminder.d1;
};

import { WorkItemResponse, TaskResponse } from '../types/work-item.types';

export { WorkItemResponse, TaskResponse };

export const formatWorkItem = (taskRecord: any): WorkItemResponse | null => {
  if (!taskRecord) return null;

  const assignee = taskRecord.assignee
    ? {
        id: taskRecord.assignee.id,
        _id: taskRecord.assignee.id,
        name: taskRecord.assignee.name,
        email: taskRecord.assignee.email,
        avatar: taskRecord.assignee.avatar,
      }
    : null;

  const cycle = taskRecord.cycle
    ? {
        id: taskRecord.cycle.id,
        _id: taskRecord.cycle.id,
        name: taskRecord.cycle.name,
      }
    : taskRecord.cycleId || null;

  const isCompleted = taskRecord.columnId === 'done';

  const subtasks = Array.isArray(taskRecord.subtasks)
    ? taskRecord.subtasks.map((subtaskRecord: any) => ({
        ...subtaskRecord,
        id: subtaskRecord.id,
        _id: subtaskRecord.id,
        completed:
          subtaskRecord.columnId === 'done' || Boolean(subtaskRecord.completed),
      }))
    : [];

  const subtaskCount = subtasks.length;
  const subtaskCompletedCount = subtasks.filter(
    (subtaskRecord: any) => subtaskRecord.completed,
  ).length;

  return {
    ...taskRecord,
    id: taskRecord.id,
    _id: taskRecord.id,
    identifier: taskRecord.identifier || null,
    sequenceNumber: taskRecord.sequenceNumber || null,
    description: taskRecord.content || '',
    content: taskRecord.content || '',
    assignee,
    cycle,
    completed: taskRecord.completed !== undefined ? Boolean(taskRecord.completed) : isCompleted,
    issueType: taskRecord.issueType || 'task',
    storyPoints: taskRecord.storyPoints ?? null,
    relations: taskRecord.relations || [],
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
      .map((w) => w[0])
      .join('')
      .toUpperCase();
  }
  return 'TASK';
};
