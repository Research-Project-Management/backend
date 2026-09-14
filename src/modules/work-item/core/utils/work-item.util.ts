import { WorkItemPriority } from '@prisma/client';

export const PRIORITY_MAP: Record<string, WorkItemPriority> = {
  none: WorkItemPriority.none,
  low: WorkItemPriority.low,
  medium: WorkItemPriority.medium,
  high: WorkItemPriority.high,
  urgent: WorkItemPriority.urgent,
};

export const mapPriority = (priority?: string): WorkItemPriority => {
  return priority
    ? PRIORITY_MAP[priority] || WorkItemPriority.none
    : WorkItemPriority.none;
};

import {
  WorkItemResponse,
  LabelMinimal,
} from '../types/work-item.types';

export { WorkItemResponse };

const resolveLabels = (record: any): LabelMinimal[] => {
  if (
    Array.isArray(record.resolvedLabels) &&
    record.resolvedLabels.length > 0
  ) {
    return record.resolvedLabels.map((labelItem: any) => ({
      id: labelItem.id || labelItem,
      name: labelItem.name || labelItem,
      color: labelItem.color || '#64748b',
    }));
  }

  const raw = record.labels;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  return raw.map((labelItem: any) => {
    if (typeof labelItem === 'string') {
      return { id: labelItem, name: labelItem, color: '#64748b' };
    }
    return {
      id: labelItem.id || labelItem.name || '',
      name: labelItem.name || labelItem.id || '',
      color: labelItem.color || '#64748b',
    };
  });
};

export const formatWorkItem = (record: any): WorkItemResponse | null => {
  if (!record) return null;

  const assignee = record.assignee
    ? {
        id: record.assignee.id,
        name: record.assignee.name,
        email: record.assignee.email,
        avatar: record.assignee.avatar,
      }
    : null;

  const cycle = record.cycle
    ? {
        id: record.cycle.id,
        name: record.cycle.name,
      }
    : record.cycleId || null;

  const isCompleted = record.columnId === 'done';

  const childWorkItems = Array.isArray(record.childWorkItems)
    ? record.childWorkItems.map((child: any) => ({
        ...child,
        id: child.id,
        completed:
          child.columnId === 'done' || Boolean(child.completed),
      }))
    : [];

  const childWorkItemCount = childWorkItems.length;
  const childWorkItemCompletedCount = childWorkItems.filter(
    (child: any) => child.completed,
  ).length;

  const labels = resolveLabels(record);

  return {
    ...record,
    id: record.id,
    identifier: record.identifier || null,
    sequenceNumber: record.sequenceNumber || null,
    description: record.content || '',
    content: record.content || '',
    assignee,
    assigneeIds: Array.isArray(record.assigneeIds)
      ? record.assigneeIds
      : record.assigneeId
        ? [record.assigneeId]
        : [],
    cycle,
    completed:
      record.completed !== undefined
        ? Boolean(record.completed)
        : isCompleted,
    relations: record.relations || [],
    labels,
    childWorkItems,
    childWorkItemCount,
    childWorkItemCompletedCount,
    parentWorkItemId: record.parentWorkItemId || null,
    parentWorkItem: record.parentWorkItem || null,
    subscriberIds: Array.isArray(record.subscriberIds)
      ? record.subscriberIds
      : [],
    attachments:
      record.attachments && typeof record.attachments === 'object' && !Array.isArray(record.attachments)
        ? {
            pages: Array.isArray(record.attachments.pages) ? record.attachments.pages : [],
            papers: Array.isArray(record.attachments.papers) ? record.attachments.papers : [],
            files: Array.isArray(record.attachments.files) ? record.attachments.files : [],
            links: Array.isArray(record.attachments.links) ? record.attachments.links : [],
          }
        : Array.isArray(record.attachments)
        ? {
            pages: [],
            papers: [],
            files: record.attachments,
            links: [],
          }
        : {
            pages: [],
            papers: [],
            files: [],
            links: [],
          },
    createdAt: record.createdAt?.toISOString?.() || record.createdAt,
    updatedAt: record.updatedAt?.toISOString?.() || record.updatedAt,
    startDate:
      record.startDate?.toISOString?.() || record.startDate || null,
    dueDate: record.dueDate?.toISOString?.() || record.dueDate || null,
  };
};

export const deriveProjectIdentifierPrefix = (
  rawIdentifier?: string | null,
  rawName?: string | null,
): string => {
  const prefix = rawIdentifier?.trim().toUpperCase();
  if (prefix) return prefix;

  const name = rawName || 'PROJ';
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
  return 'PROJ';
};
