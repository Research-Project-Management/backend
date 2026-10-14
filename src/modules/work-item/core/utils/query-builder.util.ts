import { Prisma, WorkItemPriority } from '@prisma/client';
import { WorkItemFilterOptions } from '../types/work-item.types';
import { isUuid } from '@/core';

export interface BuiltWorkItemQuery {
  where: Prisma.WorkItemWhereInput;
  orderBy: Prisma.WorkItemOrderByWithRelationInput[];
  take?: number;
  skip?: number;
}

export function normalizeFilterArray(val: unknown): string[] {
  if (val === undefined || val === null) return [];
  if (Array.isArray(val)) {
    return val
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof val === 'string') {
    if (val.includes(',')) {
      return val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const trimmed = val.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return [String(val)];
  }
  return [];
}

export async function buildWorkItemQuery(
  canonicalProjectId: string,
  filter: string | WorkItemFilterOptions | undefined,
  prismaService: {
    workItemState?: {
      findMany: (args: {
        where: Prisma.WorkItemStateWhereInput;
        select: { id: true };
      }) => Promise<Array<{ id: string }>>;
    };
  },
): Promise<BuiltWorkItemQuery> {
  const where: Prisma.WorkItemWhereInput = {
    projectId: canonicalProjectId,
    deletedAt: null,
  };

  if (filter && typeof filter === 'object' && filter.archived === true) {
    where.archivedAt = { not: null };
  } else {
    where.archivedAt = null;
  }

  const andConditions: Prisma.WorkItemWhereInput[] = [];
  let take: number | undefined;
  let skip: number | undefined;

  if (filter && typeof filter === 'object') {
    // State and State Group
    const stateFilters = normalizeFilterArray(filter.columnId || filter.state);
    if (filter.stateGroup && prismaService.workItemState) {
      const groups = normalizeFilterArray(filter.stateGroup);
      if (groups.length > 0) {
        const matchingStates = await prismaService.workItemState.findMany({
          where: { projectId: canonicalProjectId, group: { in: groups } },
          select: { id: true },
        });
        const stateIdsFromGroup = matchingStates.map((s) => s.id);
        if (stateFilters.length > 0) {
          const intersection = stateFilters.filter((id) =>
            stateIdsFromGroup.includes(id),
          );
          where.columnId = {
            in: intersection.length > 0 ? intersection : ['__no_match__'],
          };
        } else {
          where.columnId = { in: stateIdsFromGroup };
        }
      }
    } else if (stateFilters.length === 1) {
      where.columnId = stateFilters[0];
    } else if (stateFilters.length > 1) {
      where.columnId = { in: stateFilters };
    }

    // Priority
    const priorities = normalizeFilterArray(
      filter.priority,
    ) as WorkItemPriority[];
    if (priorities.length === 1) {
      where.priority = priorities[0];
    } else if (priorities.length > 1) {
      where.priority = { in: priorities };
    }

    // Assignees
    const assigneeFilters = normalizeFilterArray(
      filter.assigneeId || filter.assignees,
    );
    if (assigneeFilters.length > 0) {
      const hasUnassigned = assigneeFilters.some(
        (id) =>
          id === 'unassigned' ||
          id === 'none' ||
          id === 'null' ||
          id === '__unassigned__',
      );
      const specificAssigneeIds = assigneeFilters.filter(
        (id) =>
          isUuid(id) &&
          id !== 'unassigned' &&
          id !== 'none' &&
          id !== 'null' &&
          id !== '__unassigned__',
      );
      if (hasUnassigned && specificAssigneeIds.length > 0) {
        andConditions.push({
          OR: [
            { assigneeId: { in: specificAssigneeIds } },
            { assigneeId: null },
          ],
        });
      } else if (hasUnassigned) {
        where.assigneeId = null;
      } else if (specificAssigneeIds.length === 1) {
        where.assigneeId = specificAssigneeIds[0];
      } else if (specificAssigneeIds.length > 1) {
        where.assigneeId = { in: specificAssigneeIds };
      }
    }

    // Labels
    const labelFilters = normalizeFilterArray(filter.labels);
    if (labelFilters.length > 0) {
      where.labels = { hasSome: labelFilters };
    }

    // Author / Created By
    const authorFilters = normalizeFilterArray(
      filter.createdById || filter.authorId,
    );
    const validAuthorIds = authorFilters.filter(isUuid);
    if (validAuthorIds.length === 1) {
      where.authorId = validAuthorIds[0];
    } else if (validAuthorIds.length > 1) {
      where.authorId = { in: validAuthorIds };
    }

    // Due date
    if (filter.dueDate) {
      const due = filter.dueDate.toLowerCase().trim();
      const now = new Date();
      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const todayEnd = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999,
      );

      if (due === 'today') {
        where.dueDate = { gte: todayStart, lte: todayEnd };
      } else if (due === 'overdue') {
        where.dueDate = { lt: todayStart };
        where.completed = false;
      } else if (due === 'this_week') {
        const dayOfWeek = now.getDay() || 7;
        const weekStart = new Date(todayStart);
        weekStart.setDate(weekStart.getDate() - (dayOfWeek - 1));
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);
        where.dueDate = { gte: weekStart, lte: weekEnd };
      } else if (due === 'this_month') {
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
          23,
          59,
          59,
          999,
        );
        where.dueDate = { gte: monthStart, lte: monthEnd };
      } else if (due === 'no_date') {
        where.dueDate = null;
      }
    }

    // Parent work item
    if (filter.parentWorkItemId !== undefined) {
      if (
        filter.parentWorkItemId === 'none' ||
        filter.parentWorkItemId === 'null' ||
        filter.parentWorkItemId === '__none__'
      ) {
        where.parentWorkItemId = null;
      } else if (
        filter.parentWorkItemId === null ||
        isUuid(filter.parentWorkItemId)
      ) {
        where.parentWorkItemId = filter.parentWorkItemId;
      }
    }

    if (filter.completed !== undefined) {
      where.completed = filter.completed;
    }
    if (filter.search?.trim()) {
      const query = filter.search.trim();
      andConditions.push({
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { identifier: { contains: query, mode: 'insensitive' } },
        ],
      });
    }
    if (filter.limit) take = filter.limit;
    if (filter.offset) skip = filter.offset;
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  // Dynamic Ordering
  let orderBy: Prisma.WorkItemOrderByWithRelationInput[] = [
    { rank: 'asc' },
    { createdAt: 'desc' },
  ];
  if (filter && typeof filter === 'object' && filter.orderBy) {
    const direction =
      (filter.orderDirection || 'asc').toLowerCase() === 'desc'
        ? 'desc'
        : 'asc';
    switch (filter.orderBy) {
      case 'createdAt':
      case 'created_at':
        orderBy = [{ createdAt: direction }, { rank: 'asc' }];
        break;
      case 'updatedAt':
      case 'updated_at':
        orderBy = [{ updatedAt: direction }, { rank: 'asc' }];
        break;
      case 'priority':
        orderBy = [{ priority: direction }, { rank: 'asc' }];
        break;
      case 'dueDate':
      case 'due_date':
        orderBy = [{ dueDate: direction }, { rank: 'asc' }];
        break;
      case 'startDate':
      case 'start_date':
        orderBy = [{ startDate: direction }, { rank: 'asc' }];
        break;
      case 'title':
        orderBy = [{ title: direction }, { rank: 'asc' }];
        break;
      case 'manual':
      case 'rank':
      default:
        orderBy = [{ rank: direction }];
        break;
    }
  }

  return { where, orderBy, take, skip };
}
