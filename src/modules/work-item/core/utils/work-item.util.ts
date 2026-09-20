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
  UserMinimal,
} from '../types/work-item.types';

export { WorkItemResponse };

const resolveLabels = (
  record: any,
  labelLookup?: Map<string, { name: string; color: string }>,
): LabelMinimal[] => {
  if (
    Array.isArray(record.labelAssignments) &&
    record.labelAssignments.length > 0
  ) {
    return record.labelAssignments.map((la: any) => ({
      id: la.label?.id || la.labelId,
      name: la.label?.name || '',
      color: la.label?.color || '#3b82f6',
    }));
  }

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

  const lookup = labelLookup || record.labelLookup;

  return raw.map((labelItem: any) => {
    if (typeof labelItem === 'string') {
      const match = lookup?.get?.(labelItem);
      return {
        id: labelItem,
        name: match?.name || labelItem,
        color: match?.color || '#64748b',
      };
    }
    return {
      id: labelItem.id || labelItem.name || '',
      name: labelItem.name || labelItem.id || '',
      color: labelItem.color || '#64748b',
    };
  });
};

export const formatWorkItem = (
  record: any,
  labelLookup?: Map<string, { name: string; color: string }>,
): WorkItemResponse | null => {
  if (!record) return null;

  const assignee = record.assignee
    ? {
        id: record.assignee.id,
        name: record.assignee.profile?.name ?? record.assignee.name ?? 'User',
        email: record.assignee.email,
        avatar:
          record.assignee.profile?.avatar ?? record.assignee.avatar ?? null,
      }
    : null;

  const assignees: UserMinimal[] =
    Array.isArray(record.assignees) && record.assignees.length > 0
      ? record.assignees.map((a: any) => {
          const u = a.user || a;
          return {
            id: u.id,
            name: u.profile?.name ?? u.name ?? 'User',
            email: u.email,
            avatar: u.profile?.avatar ?? u.avatar ?? null,
          };
        })
      : assignee
        ? [assignee]
        : [];

  const assigneeIds =
    assignees.length > 0
      ? assignees.map((a) => a.id)
      : Array.isArray(record.assigneeIds)
        ? record.assigneeIds
        : record.assigneeId
          ? [record.assigneeId]
          : [];

  const cycle = record.cycle
    ? {
        id: record.cycle.id,
        name: record.cycle.name,
      }
    : record.cycleId || null;

  const isCompleted = record.state?.group
    ? record.state.group === 'completed'
    : record.columnId === 'done' || Boolean(record.completed);

  const stateGroup =
    record.state?.group || (isCompleted ? 'completed' : 'unstarted');

  const childWorkItems = Array.isArray(record.childWorkItems)
    ? record.childWorkItems.map((child: any) => {
        const childIsCompleted = child.state?.group
          ? child.state.group === 'completed'
          : child.columnId === 'done' || Boolean(child.completed);
        return {
          ...child,
          id: child.id,
          completed: childIsCompleted,
          stateGroup:
            child.state?.group ||
            (childIsCompleted ? 'completed' : 'unstarted'),
        };
      })
    : [];

  const childWorkItemCount = childWorkItems.length;
  const childWorkItemCompletedCount = childWorkItems.filter(
    (child: any) => child.completed,
  ).length;
  const progressPercentage =
    childWorkItemCount > 0
      ? Math.round((childWorkItemCompletedCount / childWorkItemCount) * 100)
      : isCompleted
        ? 100
        : 0;

  const labels = resolveLabels(record, labelLookup);

  const relations =
    (Array.isArray(record.outgoingRelations) &&
      record.outgoingRelations.length > 0) ||
    (Array.isArray(record.incomingRelations) &&
      record.incomingRelations.length > 0)
      ? [
          ...(record.outgoingRelations || []).map((r: any) => ({
            id: r.id,
            type: r.type,
            targetId: r.targetId,
            targetWorkItem: r.targetWorkItem
              ? {
                  id: r.targetWorkItem.id,
                  title: r.targetWorkItem.title,
                  identifier: r.targetWorkItem.identifier,
                }
              : undefined,
          })),
          ...(record.incomingRelations || []).map((r: any) => ({
            id: r.id,
            type:
              r.type === 'blocks'
                ? 'blocked_by'
                : r.type === 'blocked_by'
                  ? 'blocks'
                  : r.type,
            targetId: r.sourceId,
            targetWorkItem: r.sourceWorkItem
              ? {
                  id: r.sourceWorkItem.id,
                  title: r.sourceWorkItem.title,
                  identifier: r.sourceWorkItem.identifier,
                }
              : undefined,
          })),
        ]
      : record.relations || [];

  return {
    ...record,
    id: record.id,
    identifier: record.identifier || null,
    sequenceNumber: record.sequenceNumber || null,
    description: record.content || '',
    content: record.content || '',
    columnId: record.columnId,
    state: record.state || null,
    stateGroup,
    progressPercentage,
    assignee,
    assignees,
    assigneeIds,
    cycle,
    completed: isCompleted,
    relations,
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
      record.attachments &&
      typeof record.attachments === 'object' &&
      !Array.isArray(record.attachments)
        ? {
            pages: Array.isArray(record.attachments.pages)
              ? record.attachments.pages
              : [],
            papers: Array.isArray(record.attachments.papers)
              ? record.attachments.papers
              : [],
            files: Array.isArray(record.attachments.files)
              ? record.attachments.files
              : [],
            links: Array.isArray(record.attachments.links)
              ? record.attachments.links
              : [],
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
    startDate: record.startDate?.toISOString?.() || record.startDate || null,
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
