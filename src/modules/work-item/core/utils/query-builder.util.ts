import { Prisma, WorkItemPriority, EntityType } from '@prisma/client';
import { WorkItemFilterOptions } from '@/modules/work-item/core/types/core.types';
import { isUuid } from '@/core';
import { resolveAttachmentFilterPluralCategory } from './attachment.util';

export interface BuiltWorkItemQuery {
  where: Prisma.WorkItemWhereInput;
  orderBy: Prisma.WorkItemOrderByWithRelationInput[];
  take?: number;
  skip?: number;
}

type DateFilterField = 'dueDate' | 'startDate' | 'createdAt' | 'updatedAt';
type DateTokenBuilder = (
  field: DateFilterField,
  now: Date,
  todayStart: Date,
  todayEnd: Date,
) => Prisma.WorkItemWhereInput | null;

const buildRelativeDaysCondition = (
  field: DateFilterField,
  todayStart: Date,
  days: number,
): Prisma.WorkItemWhereInput => {
  const rangeEnd = new Date(todayStart);
  rangeEnd.setDate(rangeEnd.getDate() + days);
  rangeEnd.setHours(23, 59, 59, 999);
  return { [field]: { gte: todayStart, lte: rangeEnd } };
};

const buildNoDateCondition: DateTokenBuilder = (field) =>
  field === 'dueDate' || field === 'startDate' ? { [field]: null } : null;

const DATE_TOKEN_STRATEGIES: Readonly<Record<string, DateTokenBuilder>> = {
  today: (field, _now, todayStart, todayEnd) => ({
    [field]: { gte: todayStart, lte: todayEnd },
  }),
  overdue: (field, _now, todayStart) =>
    field === 'dueDate'
      ? { dueDate: { lt: todayStart }, completed: false }
      : null,
  this_week: (field, now, todayStart) => {
    const dayOfWeek = now.getDay() || 7;
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - (dayOfWeek - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    return { [field]: { gte: weekStart, lte: weekEnd } };
  },
  next_week: (field, now, todayStart) => {
    const dayOfWeek = now.getDay() || 7;
    const nextWeekStart = new Date(todayStart);
    nextWeekStart.setDate(nextWeekStart.getDate() + (8 - dayOfWeek));
    const nextWeekEnd = new Date(nextWeekStart);
    nextWeekEnd.setDate(nextWeekEnd.getDate() + 6);
    nextWeekEnd.setHours(23, 59, 59, 999);
    return { [field]: { gte: nextWeekStart, lte: nextWeekEnd } };
  },
  this_month: (field, now) => {
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
    return { [field]: { gte: monthStart, lte: monthEnd } };
  },
  this_year: (field, now) => {
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const yearEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    return { [field]: { gte: yearStart, lte: yearEnd } };
  },
  '15_days': (field, _now, todayStart) =>
    buildRelativeDaysCondition(field, todayStart, 15),
  '30_days': (field, _now, todayStart) =>
    buildRelativeDaysCondition(field, todayStart, 30),
  no_date: buildNoDateCondition,
  none: buildNoDateCondition,
  __no_date__: buildNoDateCondition,
};

const ORDER_BY_FIELD_MAP: Readonly<
  Record<string, keyof Prisma.WorkItemOrderByWithRelationInput>
> = {
  createdAt: 'createdAt',
  created_at: 'createdAt',
  updatedAt: 'updatedAt',
  updated_at: 'updatedAt',
  priority: 'priority',
  dueDate: 'dueDate',
  due_date: 'dueDate',
  startDate: 'startDate',
  start_date: 'startDate',
  title: 'title',
};

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

function buildSingleDateCondition(
  field: 'dueDate' | 'startDate' | 'createdAt' | 'updatedAt',
  rawVal: string,
): Prisma.WorkItemWhereInput | null {
  const token = rawVal.toLowerCase().trim();
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
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

  const strategy = DATE_TOKEN_STRATEGIES[token];
  if (strategy) {
    return strategy(field, now, todayStart, todayEnd);
  }
  if (token.includes('..')) {
    const [fromStr, toStr] = token.split('..').map((s) => s.trim());
    const range: Prisma.DateTimeNullableFilter = {};
    if (fromStr) {
      const fromDate = new Date(fromStr);
      if (!Number.isNaN(fromDate.getTime())) {
        fromDate.setHours(0, 0, 0, 0);
        range.gte = fromDate;
      }
    }
    if (toStr) {
      const toDate = new Date(toStr);
      if (!Number.isNaN(toDate.getTime())) {
        toDate.setHours(23, 59, 59, 999);
        range.lte = toDate;
      }
    }
    if (range.gte || range.lte) {
      return { [field]: range };
    }
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(token)) {
    const parsed = new Date(token);
    if (!Number.isNaN(parsed.getTime())) {
      const dayStart = new Date(
        parsed.getFullYear(),
        parsed.getMonth(),
        parsed.getDate(),
        0,
        0,
        0,
        0,
      );
      const dayEnd = new Date(
        parsed.getFullYear(),
        parsed.getMonth(),
        parsed.getDate(),
        23,
        59,
        59,
        999,
      );
      return { [field]: { gte: dayStart, lte: dayEnd } };
    }
  }
  return null;
}

function applyDateFilter(
  field: 'dueDate' | 'startDate' | 'createdAt' | 'updatedAt',
  rawInput: string | string[] | undefined,
  where: Prisma.WorkItemWhereInput,
  andConditions: Prisma.WorkItemWhereInput[],
): void {
  const values = normalizeFilterArray(rawInput);
  if (values.length === 0) return;

  if (values.length === 1) {
    const single = buildSingleDateCondition(field, values[0]);
    if (!single) return;
    if (
      values[0].toLowerCase().trim() === 'overdue' &&
      field === 'dueDate' &&
      single.dueDate
    ) {
      where.dueDate = single.dueDate;
      where.completed = false;
    } else if (single[field] !== undefined) {
      (where as Record<string, unknown>)[field] = single[field];
    }
    return;
  }

  const orClauses = values
    .map((val) => buildSingleDateCondition(field, val))
    .filter((c): c is Prisma.WorkItemWhereInput => c !== null);

  if (orClauses.length === 1) {
    andConditions.push(orClauses[0]);
  } else if (orClauses.length > 1) {
    andConditions.push({ OR: orClauses });
  }
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
    entityAttachment?: {
      findMany: (args: {
        where: Prisma.EntityAttachmentWhereInput;
        select: {
          entityId: true;
          mimeType: true;
          metadata: true;
        };
      }) => Promise<
        Array<{
          entityId: string | null;
          mimeType: string | null;
          metadata: Prisma.JsonValue;
        }>
      >;
    };
    workItemEntityLink?: {
      findMany: (args: {
        where: Record<string, unknown>;
        select: { workItemId: true };
      }) => Promise<Array<{ workItemId: string }>>;
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
    // 1. Work Items (specific IDs or identifiers)
    const workItemTokens = normalizeFilterArray(filter.workItems || filter.ids);
    if (workItemTokens.length > 0) {
      const uuids = workItemTokens.filter(isUuid);
      const identifiers = workItemTokens.filter((t) => !isUuid(t));
      if (uuids.length > 0 && identifiers.length === 0) {
        where.id = uuids.length === 1 ? uuids[0] : { in: uuids };
      } else if (identifiers.length > 0 && uuids.length === 0) {
        where.identifier =
          identifiers.length === 1
            ? { equals: identifiers[0], mode: 'insensitive' }
            : { in: identifiers, mode: 'insensitive' };
      } else if (uuids.length > 0 && identifiers.length > 0) {
        andConditions.push({
          OR: [
            { id: { in: uuids } },
            { identifier: { in: identifiers, mode: 'insensitive' } },
          ],
        });
      }
    }

    // 2. State and State Group
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

    // 3. Priority
    const priorities = normalizeFilterArray(
      filter.priority,
    ) as WorkItemPriority[];
    if (priorities.length === 1) {
      where.priority = priorities[0];
    } else if (priorities.length > 1) {
      where.priority = { in: priorities };
    }

    // 4. Assignees
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
            ...specificAssigneeIds.map((uid) => ({
              assigneeIds: { array_contains: [uid] },
            })),
            { assigneeId: null },
          ],
        });
      } else if (hasUnassigned) {
        where.assigneeId = null;
      } else if (specificAssigneeIds.length === 1) {
        andConditions.push({
          OR: [
            { assigneeId: specificAssigneeIds[0] },
            { assigneeIds: { array_contains: [specificAssigneeIds[0]] } },
          ],
        });
      } else if (specificAssigneeIds.length > 1) {
        andConditions.push({
          OR: [
            { assigneeId: { in: specificAssigneeIds } },
            ...specificAssigneeIds.map((uid) => ({
              assigneeIds: { array_contains: [uid] },
            })),
          ],
        });
      }
    }

    // 5. Subscribers
    const subscriberFilters = normalizeFilterArray(filter.subscribers).filter(
      isUuid,
    );
    if (subscriberFilters.length === 1) {
      where.subscriberIds = { array_contains: [subscriberFilters[0]] };
    } else if (subscriberFilters.length > 1) {
      andConditions.push({
        OR: subscriberFilters.map((subId) => ({
          subscriberIds: { array_contains: [subId] },
        })),
      });
    }

    // 6. Mentions
    const mentionFilters = normalizeFilterArray(filter.mentions);
    if (mentionFilters.length > 0) {
      const mentionOrClauses: Prisma.WorkItemWhereInput[] = [];
      for (const mId of mentionFilters) {
        mentionOrClauses.push(
          { content: { contains: `(${mId})`, mode: 'insensitive' } },
          { content: { contains: `@${mId}`, mode: 'insensitive' } },
          { title: { contains: `@${mId}`, mode: 'insensitive' } },
          {
            comments: {
              some: {
                OR: [
                  { content: { contains: `(${mId})`, mode: 'insensitive' } },
                  { content: { contains: `@${mId}`, mode: 'insensitive' } },
                ],
              },
            },
          },
        );
      }
      if (mentionOrClauses.length > 0) {
        andConditions.push({ OR: mentionOrClauses });
      }
    }

    // 7. Labels
    const labelFilters = normalizeFilterArray(filter.labels);
    if (labelFilters.length > 0) {
      const hasNoLabel = labelFilters.some(
        (l) => l === '__no_label__' || l === 'none' || l === 'no_label',
      );
      const specificLabels = labelFilters.filter(
        (l) => l !== '__no_label__' && l !== 'none' && l !== 'no_label',
      );
      if (hasNoLabel && specificLabels.length === 0) {
        where.labels = { isEmpty: true };
      } else if (specificLabels.length > 0 && !hasNoLabel) {
        where.labels = { hasSome: specificLabels };
      } else if (hasNoLabel && specificLabels.length > 0) {
        andConditions.push({
          OR: [
            { labels: { isEmpty: true } },
            { labels: { hasSome: specificLabels } },
          ],
        });
      }
    }

    // 8. Attachments (Attach Center categories)
    const attachFilters = normalizeFilterArray(filter.attach);
    if (attachFilters.length > 0 && prismaService.entityAttachment?.findMany) {
      try {
        const allAtts = await prismaService.entityAttachment.findMany({
          where: {
            entityType: EntityType.work_item,
            projectId: canonicalProjectId,
          },
          select: {
            entityId: true,
            mimeType: true,
            metadata: true,
          },
        });
        const matchedIds = new Set<string>();
        const normalizedTokens = attachFilters.map((a) =>
          a.toLowerCase().replace(/^attach:/, ''),
        );
        for (const att of allAtts) {
          if (!att.entityId) continue;
          const category = resolveAttachmentFilterPluralCategory(
            att.mimeType,
            att.metadata,
          );

          if (
            normalizedTokens.includes('has_attachments') ||
            normalizedTokens.includes('has:attach') ||
            normalizedTokens.includes('any') ||
            normalizedTokens.includes(category)
          ) {
            matchedIds.add(att.entityId);
          }
        }
        if (
          prismaService.workItemEntityLink?.findMany &&
          (normalizedTokens.includes('has_attachments') ||
            normalizedTokens.includes('has:attach') ||
            normalizedTokens.includes('any') ||
            normalizedTokens.includes('pages') ||
            normalizedTokens.includes('papers'))
        ) {
          const entityTypes: string[] = [];
          if (
            normalizedTokens.includes('has_attachments') ||
            normalizedTokens.includes('has:attach') ||
            normalizedTokens.includes('any')
          ) {
            entityTypes.push('page', 'paper');
          } else {
            if (normalizedTokens.includes('pages')) entityTypes.push('page');
            if (normalizedTokens.includes('papers')) entityTypes.push('paper');
          }
          if (entityTypes.length > 0) {
            const linkedRows = await prismaService.workItemEntityLink
              .findMany({
                where: {
                  entityType: { in: entityTypes },
                  workItem: { projectId: canonicalProjectId, deletedAt: null },
                },
                select: { workItemId: true },
              })
              .catch(() => []);
            for (const row of linkedRows) {
              if (row.workItemId) matchedIds.add(row.workItemId);
            }
          }
        }
        andConditions.push({
          id: {
            in: matchedIds.size > 0 ? Array.from(matchedIds) : ['__no_match__'],
          },
        });
      } catch {
        // Ignore if table not present in mock
      }
    }

    // 9. Author / Created By
    const authorFilters = normalizeFilterArray(
      filter.createdById || filter.authorId,
    );
    const validAuthorIds = authorFilters.filter(isUuid);
    if (validAuthorIds.length === 1) {
      where.authorId = validAuthorIds[0];
    } else if (validAuthorIds.length > 1) {
      where.authorId = { in: validAuthorIds };
    }

    // 10. Dates (dueDate, startDate, createdAt, updatedAt)
    applyDateFilter('dueDate', filter.dueDate, where, andConditions);
    applyDateFilter('startDate', filter.startDate, where, andConditions);
    applyDateFilter('createdAt', filter.createdAt, where, andConditions);
    applyDateFilter('updatedAt', filter.updatedAt, where, andConditions);

    // 11. Parent work item
    const rawParent =
      filter.parentWorkItemId !== undefined
        ? filter.parentWorkItemId
        : filter.parent;
    if (rawParent !== undefined) {
      if (rawParent === null) {
        where.parentWorkItemId = null;
      } else {
        const parentTokens = normalizeFilterArray(rawParent);
        if (parentTokens.length === 1) {
          const p = parentTokens[0];
          if (
            p === 'none' ||
            p === 'null' ||
            p === '__none__' ||
            p === 'parent:none'
          ) {
            where.parentWorkItemId = null;
          } else if (p === '__has_parent__' || p === 'parent:any') {
            where.parentWorkItemId = { not: null };
          } else if (isUuid(p)) {
            where.parentWorkItemId = p;
          } else {
            where.parentWorkItem = {
              identifier: { equals: p, mode: 'insensitive' },
            };
          }
        } else if (parentTokens.length > 1) {
          const parentOr: Prisma.WorkItemWhereInput[] = [];
          const hasNone = parentTokens.some(
            (p) =>
              p === 'none' ||
              p === 'null' ||
              p === '__none__' ||
              p === 'parent:none',
          );
          const hasAny = parentTokens.some(
            (p) => p === '__has_parent__' || p === 'parent:any',
          );
          const parentUuids = parentTokens.filter(isUuid);
          const parentIdentifiers = parentTokens.filter(
            (p) =>
              !isUuid(p) &&
              p !== 'none' &&
              p !== 'null' &&
              p !== '__none__' &&
              p !== 'parent:none' &&
              p !== '__has_parent__' &&
              p !== 'parent:any',
          );
          if (hasNone) parentOr.push({ parentWorkItemId: null });
          if (hasAny) parentOr.push({ parentWorkItemId: { not: null } });
          if (parentUuids.length > 0) {
            parentOr.push({ parentWorkItemId: { in: parentUuids } });
          }
          if (parentIdentifiers.length > 0) {
            parentOr.push({
              parentWorkItem: {
                identifier: { in: parentIdentifiers, mode: 'insensitive' },
              },
            });
          }
          if (parentOr.length === 1) {
            andConditions.push(parentOr[0]);
          } else if (parentOr.length > 1) {
            andConditions.push({ OR: parentOr });
          }
        }
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
    const mappedOrderField = ORDER_BY_FIELD_MAP[filter.orderBy];
    if (mappedOrderField) {
      orderBy = [{ [mappedOrderField]: direction }, { rank: 'asc' }];
    } else {
      orderBy = [{ rank: direction }];
    }
  }

  return { where, orderBy, take, skip };
}
