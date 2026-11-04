import { WorkItemPriority, Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import type { WorkItemWithRelations } from '@/modules/work-item/core/types/core.types';

export const MAX_HIERARCHY_DEPTH = 10;

export interface HierarchyParentStub {
  id: string;
  parentWorkItemId?: string | null;
}

export async function validateHierarchyCycle(
  targetWorkItemId: string,
  initialParent: HierarchyParentStub,
  findWorkItemById: (
    id: string,
  ) => Promise<HierarchyParentStub | WorkItemWithRelations | null>,
  maxDepth: number = MAX_HIERARCHY_DEPTH,
): Promise<void> {
  if (initialParent.id === targetWorkItemId) {
    throw new BadRequestException(
      'A work item cannot be set as its own parent',
    );
  }

  let curr: HierarchyParentStub | null = initialParent;
  const visited = new Set<string>([targetWorkItemId, initialParent.id]);
  let depth = 1;

  while (curr && curr.parentWorkItemId) {
    if (visited.has(curr.parentWorkItemId)) {
      throw new BadRequestException(
        'Cannot set a descendant or cyclical ancestor as the parent work item',
      );
    }
    depth += 1;
    if (depth > maxDepth) {
      throw new BadRequestException(
        `Hierarchy depth cannot exceed ${maxDepth} levels`,
      );
    }
    visited.add(curr.parentWorkItemId);
    curr = await findWorkItemById(curr.parentWorkItemId);
  }
}

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
} from '@/modules/work-item/core/types/core.types';
import { mapUserMinimal } from '@/modules/work-item/common/types/shared.types';
import { isStateCompleted } from '@/modules/work-item/state/utils/state.util';

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

  const assignee = mapUserMinimal(record.assignee);

  const assignees: UserMinimal[] =
    Array.isArray(record.assignees) && record.assignees.length > 0
      ? record.assignees.map((a) => {
          const u = a.user || a;
          return (
            mapUserMinimal({
              id: u.id || '',
              name: u.name,
              email: u.email,
              avatar: u.avatar,
              profile: u.profile,
            }) || {
              id: u.id || '',
              name: 'User',
              email: null,
              avatar: null,
            }
          );
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

  const isCompleted = isStateCompleted(record);

  const stateGroup =
    record.state?.group || (isCompleted ? 'completed' : 'unstarted');

  const childWorkItems: ChildWorkItemMinimal[] = Array.isArray(
    record.childWorkItems,
  )
    ? record.childWorkItems.map((child: RawWorkItemRecord) => {
        const childIsCompleted = isStateCompleted(child);
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
          assignee: mapUserMinimal(child.assignee),
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

  const jsonSubtypeMap = new Map<string, string>();
  if (Array.isArray(record.relations)) {
    for (const jr of record.relations as Array<{
      targetWorkItemId?: string;
      targetId?: string;
      type?: string;
    }>) {
      const tId = jr?.targetWorkItemId || jr?.targetId;
      if (tId && typeof jr?.type === 'string') {
        jsonSubtypeMap.set(tId, jr.type);
      }
    }
  }

  const relations =
    (Array.isArray(record.outgoingRelations) &&
      record.outgoingRelations.length > 0) ||
    (Array.isArray(record.incomingRelations) &&
      record.incomingRelations.length > 0)
      ? [
          ...(record.outgoingRelations || []).map((r) => ({
            id: r.id,
            type: jsonSubtypeMap.get(r.targetId) || r.type,
            targetId: r.targetId,
            targetWorkItemId: r.targetId,
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
              jsonSubtypeMap.get(r.sourceId) ||
              (r.type === 'blocks'
                ? 'blocked_by'
                : r.type === 'blocked_by'
                  ? 'blocks'
                  : r.type),
            targetId: r.sourceId,
            targetWorkItemId: r.sourceId,
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

export function calculateWorkItemAnalytics(items: unknown[]) {
  const byStateGroup: Record<string, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
  };
  const byPriority: Record<string, number> = {
    none: 0,
    low: 0,
    medium: 0,
    high: 0,
    urgent: 0,
  };

  let completedCount = 0;
  let cancelledCount = 0;
  let overdueCount = 0;
  let totalTimeSpent = 0;
  const now = Date.now();

  for (const rawItem of items) {
    const item = rawItem as {
      stateGroup?: string | null;
      priority?: string | null;
      completed?: boolean | null;
      dueDate?: string | Date | null;
      timeSpent?: number | null;
    };
    const group = (
      typeof item.stateGroup === 'string' ? item.stateGroup : 'unstarted'
    ).toLowerCase();
    byStateGroup[group] = (byStateGroup[group] || 0) + 1;

    const prio = (
      typeof item.priority === 'string' ? item.priority : 'none'
    ).toLowerCase();
    byPriority[prio] = (byPriority[prio] || 0) + 1;

    const isDone = Boolean(item.completed) || group === 'completed';
    if (isDone) {
      completedCount += 1;
    } else if (group === 'cancelled') {
      cancelledCount += 1;
    } else if (item.dueDate && new Date(item.dueDate).getTime() < now) {
      overdueCount += 1;
    }

    if (typeof item.timeSpent === 'number' && !isNaN(item.timeSpent)) {
      totalTimeSpent += item.timeSpent;
    }
  }

  const total = items.length;
  const actionableTotal = Math.max(0, total - cancelledCount);
  const completionRate =
    actionableTotal > 0
      ? Math.round((completedCount / actionableTotal) * 100)
      : 0;

  return {
    total,
    completed: completedCount,
    overdue: overdueCount,
    completionRate,
    totalTimeSpent: Number(totalTimeSpent.toFixed(2)),
    byStateGroup,
    byPriority,
  };
}

export { deriveProjectPrefix };
