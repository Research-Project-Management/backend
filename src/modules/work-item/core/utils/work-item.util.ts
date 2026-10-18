import { WorkItemPriority, Prisma } from '@prisma/client';

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

import type {
  WorkItemResponse,
  LabelMinimal,
  UserMinimal,
  ChildWorkItemMinimal,
  StateMinimal,
  ParentWorkItemMinimal,
} from '@/modules/work-item/core/types/work-item.types';

export type { WorkItemResponse };

export interface RawWorkItemRecord {
  id?: string;
  identifier?: string | null;
  sequenceNumber?: number | null;
  title?: string;
  description?: string | null;
  content?: string | null;
  columnId?: string;
  priority?: string;
  projectId?: string;
  authorId?: string;
  assigneeId?: string | null;
  assigneeIds?: unknown;
  dueDate?: Date | string | null;
  startDate?: Date | string | null;
  timeSpent?: number | null;
  rank?: number;
  completed?: boolean;
  archivedAt?: Date | string | null;
  deletedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  metadata?: unknown;
  state?: {
    id?: string;
    name?: string;
    color?: string;
    group?: string;
    sequence?: number;
    isDefault?: boolean;
  } | null;
  assignee?: {
    id: string;
    name?: string | null;
    email?: string | null;
    avatar?: string | null;
    profile?: { name?: string | null; avatar?: string | null } | null;
  } | null;
  assignees?: Array<{
    isPrimary?: boolean;
    user?: {
      id: string;
      name?: string | null;
      email?: string | null;
      avatar?: string | null;
      profile?: { name?: string | null; avatar?: string | null } | null;
    };
    id?: string;
    name?: string | null;
    email?: string | null;
    avatar?: string | null;
    profile?: { name?: string | null; avatar?: string | null } | null;
  }>;
  labelAssignments?: Array<{
    labelId?: string;
    label?: { id: string; name: string; color: string };
  }>;
  resolvedLabels?: Array<{ id: string; name: string; color: string } | string>;
  labels?: unknown;
  labelLookup?: Map<string, { name: string; color: string }>;
  childWorkItems?: Array<RawWorkItemRecord & { stateGroup?: string }>;
  outgoingRelations?: Array<{
    id: string;
    type: string;
    targetId: string;
    targetWorkItem?: {
      id: string;
      title: string;
      identifier: string | null;
    };
  }>;
  incomingRelations?: Array<{
    id: string;
    type: string;
    sourceId: string;
    sourceWorkItem?: {
      id: string;
      title: string;
      identifier: string | null;
    };
  }>;
  parentWorkItemId?: string | null;
  parentWorkItem?: {
    id?: string;
    title?: string;
    identifier?: string | null;
  } | null;
  relations?: unknown;
  subscriberIds?: unknown;
  attachments?: unknown;
  [key: string]: unknown;
}

const resolveLabels = (
  record: RawWorkItemRecord,
  labelLookup?: Map<string, { name: string; color: string }>,
): LabelMinimal[] => {
  if (
    Array.isArray(record.labelAssignments) &&
    record.labelAssignments.length > 0
  ) {
    return record.labelAssignments.map((la) => ({
      id: la.label?.id || la.labelId || '',
      name: la.label?.name || '',
      color: la.label?.color || '#3b82f6',
    }));
  }

  if (
    Array.isArray(record.resolvedLabels) &&
    record.resolvedLabels.length > 0
  ) {
    return record.resolvedLabels.map((labelItem) => {
      if (typeof labelItem === 'object' && labelItem !== null) {
        return {
          id: labelItem.id,
          name: labelItem.name,
          color: labelItem.color || '#64748b',
        };
      }
      return {
        id: String(labelItem),
        name: String(labelItem),
        color: '#64748b',
      };
    });
  }

  const raw = record.labels;
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const lookup = labelLookup || record.labelLookup;

  return raw.map((labelItem) => {
    if (typeof labelItem === 'string') {
      const match = lookup?.get?.(labelItem);
      return {
        id: labelItem,
        name: match?.name || labelItem,
        color: match?.color || '#64748b',
      };
    }
    if (typeof labelItem === 'object' && labelItem !== null) {
      const item = labelItem as { id?: string; name?: string; color?: string };
      return {
        id: item.id || item.name || '',
        name: item.name || item.id || '',
        color: item.color || '#64748b',
      };
    }
    return {
      id: String(labelItem),
      name: String(labelItem),
      color: '#64748b',
    };
  });
};

export const formatWorkItem = (
  record: RawWorkItemRecord | null | undefined,
  labelLookup?: Map<string, { name: string; color: string }>,
): WorkItemResponse | null => {
  if (!record) return null;

  const assignee = record.assignee
    ? {
        id: record.assignee.id,
        name: record.assignee.profile?.name ?? record.assignee.name ?? 'User',
        email: record.assignee.email || null,
        avatar:
          record.assignee.profile?.avatar ?? record.assignee.avatar ?? null,
      }
    : null;

  const assignees: UserMinimal[] =
    Array.isArray(record.assignees) && record.assignees.length > 0
      ? record.assignees.map((a) => {
          const u = a.user || a;
          return {
            id: u.id || '',
            name: u.profile?.name ?? u.name ?? 'User',
            email: u.email || null,
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

  const isCompleted = record.state?.group
    ? record.state.group === 'completed'
    : record.columnId === 'done' || Boolean(record.completed);

  const stateGroup =
    record.state?.group || (isCompleted ? 'completed' : 'unstarted');

  const childWorkItems: ChildWorkItemMinimal[] = Array.isArray(
    record.childWorkItems,
  )
    ? record.childWorkItems.map((child: RawWorkItemRecord) => {
        const childIsCompleted = child.state?.group
          ? child.state.group === 'completed'
          : child.columnId === 'done' || Boolean(child.completed);
        return {
          id: child.id || '',
          title: child.title || '',
          identifier: child.identifier || null,
          columnId: child.columnId || '',
          completed: childIsCompleted,
          rank: typeof child.rank === 'number' ? child.rank : 0,
          stateGroup:
            child.state?.group ||
            (childIsCompleted ? 'completed' : 'unstarted'),
          assigneeId: child.assigneeId || null,
          assignee: child.assignee
            ? {
                id: child.assignee.id,
                name:
                  child.assignee.profile?.name ?? child.assignee.name ?? 'User',
                email: child.assignee.email ?? null,
                avatar:
                  child.assignee.profile?.avatar ??
                  child.assignee.avatar ??
                  null,
              }
            : null,
          state: child.state
            ? {
                id: child.state.id || '',
                name: child.state.name || '',
                color: child.state.color || '#64748b',
                group: child.state.group || 'unstarted',
                sequence: child.state.sequence ?? 0,
                isDefault: Boolean(child.state.isDefault),
              }
            : null,
          dueDate: child.dueDate || null,
        };
      })
    : [];

  const childWorkItemCount = childWorkItems.length;
  const childWorkItemCompletedCount = childWorkItems.filter(
    (child) => child.completed,
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
          ...(record.outgoingRelations || []).map((r) => ({
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
          ...(record.incomingRelations || []).map((r) => ({
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
      : (record.relations as unknown[]) || [];

  const state: StateMinimal | null = record.state
    ? {
        id: record.state.id || '',
        name: record.state.name || '',
        color: record.state.color || '#64748b',
        group: record.state.group || 'unstarted',
        sequence: record.state.sequence ?? 0,
        isDefault: Boolean(record.state.isDefault),
      }
    : null;

  const parentWorkItem: ParentWorkItemMinimal | null =
    record.parentWorkItem &&
    typeof record.parentWorkItem === 'object' &&
    record.parentWorkItem.id
      ? {
          id: String(record.parentWorkItem.id),
          title: String(record.parentWorkItem.title || ''),
          identifier: record.parentWorkItem.identifier || null,
        }
      : null;

  const att = record.attachments;
  const isObj = att !== null && typeof att === 'object' && !Array.isArray(att);
  const attRecord = isObj ? (att as Record<string, unknown>) : null;
  const attachments = attRecord
    ? {
        pages: Array.isArray(attRecord.pages) ? attRecord.pages : [],
        papers: Array.isArray(attRecord.papers) ? attRecord.papers : [],
        files: Array.isArray(attRecord.files) ? attRecord.files : [],
        links: Array.isArray(attRecord.links) ? attRecord.links : [],
      }
    : Array.isArray(att)
      ? {
          pages: [],
          papers: [],
          files: att,
          links: [],
        }
      : {
          pages: [],
          papers: [],
          files: [],
          links: [],
        };

  const toIso = (d: Date | string | undefined | null): string => {
    if (!d) return new Date().toISOString();
    return d instanceof Date ? d.toISOString() : String(d);
  };
  const toIsoNull = (d: Date | string | undefined | null): string | null => {
    if (!d) return null;
    return d instanceof Date ? d.toISOString() : String(d);
  };

  const priority: WorkItemPriority =
    typeof record.priority === 'string'
      ? mapPriority(record.priority)
      : WorkItemPriority.none;

  return {
    ...record,
    id: record.id || '',
    title: record.title || '',
    identifier: record.identifier || null,
    sequenceNumber: record.sequenceNumber || null,
    description: record.content || record.description || '',
    content: record.content || record.description || '',
    columnId: record.columnId || '',
    priority,
    projectId: record.projectId || '',
    authorId: record.authorId || '',
    rank: typeof record.rank === 'number' ? record.rank : 0,
    state,
    stateGroup,
    progressPercentage,
    assignee,
    assignees,
    assigneeIds,
    completed: isCompleted,
    relations: relations as unknown as Prisma.JsonValue,
    labels,
    childWorkItems,
    childWorkItemCount,
    childWorkItemCompletedCount,
    parentWorkItemId:
      typeof record.parentWorkItemId === 'string'
        ? record.parentWorkItemId
        : null,
    parentWorkItem,
    subscriberIds: Array.isArray(record.subscriberIds)
      ? (record.subscriberIds as string[])
      : [],
    attachments,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    startDate: toIsoNull(record.startDate),
    dueDate: toIsoNull(record.dueDate),
  };
};

import { deriveProjectPrefix } from '@/modules/project/core/utils/identifier.util';

export { deriveProjectPrefix };
