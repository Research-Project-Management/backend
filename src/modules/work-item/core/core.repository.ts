import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUuid } from '@/core';
import { Prisma, WorkItem, EntityType, WorkItemPriority } from '@prisma/client';
import {
  IWorkItemRepository,
  WorkItemWithRelations,
  WorkItemFilterOptions,
  WorkItemAttachments,
  USER_MINIMAL_SELECT,
  STATE_MINIMAL_SELECT,
  CHILD_WORK_ITEM_SELECT,
} from './types/work-item.types';
import { deriveProjectIdentifierPrefix } from './utils/work-item.util';

export const BASE_WORK_ITEM_INCLUDE = {
  state: { select: STATE_MINIMAL_SELECT },
  assignee: { select: USER_MINIMAL_SELECT },
  assignees: {
    select: {
      isPrimary: true,
      user: { select: USER_MINIMAL_SELECT },
    },
  },
  labelAssignments: {
    select: {
      label: { select: { id: true, name: true, color: true } },
    },
  },
  parentWorkItem: { select: { id: true, title: true, identifier: true } },
  childWorkItems: {
    where: { deletedAt: null },
    select: CHILD_WORK_ITEM_SELECT,
    orderBy: { rank: 'asc' as const },
  },
  project: { select: { id: true } },
} as const;

interface RawAttachmentRecord {
  id: string;
  entityId?: string;
  metadata?: unknown;
  mimeType?: string | null;
  filename?: string | null;
  url?: string | null;
  size?: number | null;
  createdAt?: Date | string | null;
  [key: string]: unknown;
}

@Injectable()
export class CoreRepository implements IWorkItemRepository {
  private readonly logger = new Logger(CoreRepository.name);

  constructor(private readonly prismaService: PrismaService) {}

  private async executeTx<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (typeof this.prismaService.$transaction === 'function') {
      return this.prismaService.$transaction(fn);
    }
    return fn(this.prismaService);
  }

  private async resolveCanonicalProjectId(
    projectId: string,
  ): Promise<string | null> {
    if (isUuid(projectId)) {
      return projectId;
    }
    const project = await this.prismaService.project
      .findFirst({
        where: {
          identifier: { equals: projectId, mode: 'insensitive' },
          deletedAt: null,
        },
        select: { id: true },
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to resolve project identifier ${projectId}: ${(err as Error).message}`,
        );
        return null;
      });
    return project?.id ?? null;
  }

  async findProjectWorkItems(
    projectId: string,
    filter?: string | WorkItemFilterOptions,
  ): Promise<WorkItemWithRelations[]> {
    const canonicalProjectId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalProjectId) return [];

    const where: Prisma.WorkItemWhereInput = {
      projectId: canonicalProjectId,
      deletedAt: null,
    };

    if (filter && typeof filter === 'object' && filter.archived === true) {
      where.archivedAt = { not: null };
    } else {
      where.archivedAt = null;
    }

    let take: number | undefined;
    let skip: number | undefined;

    if (filter && typeof filter === 'object') {
      const normalizeArray = (val: unknown): string[] => {
        if (val === undefined || val === null) return [];
        if (Array.isArray(val))
          return val
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean);
        if (typeof val === 'string') {
          if (val.includes(','))
            return val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          const trimmed = val.trim();
          return trimmed ? [trimmed] : [];
        }
        if (typeof val === 'number' || typeof val === 'boolean') {
          return [String(val)];
        }
        return [];
      };

      // State and State Group
      const stateFilters = normalizeArray(filter.columnId || filter.state);
      if (filter.stateGroup) {
        const groups = normalizeArray(filter.stateGroup);
        if (groups.length > 0) {
          const matchingStates =
            await this.prismaService.workItemState.findMany({
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
      const priorities = normalizeArray(filter.priority) as WorkItemPriority[];
      if (priorities.length === 1) {
        where.priority = priorities[0];
      } else if (priorities.length > 1) {
        where.priority = { in: priorities };
      }

      // Assignees
      const assigneeFilters = normalizeArray(
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
          where.OR = [
            { assigneeId: { in: specificAssigneeIds } },
            { assigneeId: null },
          ];
        } else if (hasUnassigned) {
          where.assigneeId = null;
        } else if (specificAssigneeIds.length === 1) {
          where.assigneeId = specificAssigneeIds[0];
        } else if (specificAssigneeIds.length > 1) {
          where.assigneeId = { in: specificAssigneeIds };
        }
      }

      // Labels
      const labelFilters = normalizeArray(filter.labels);
      if (labelFilters.length > 0) {
        where.labels = { hasSome: labelFilters };
      }

      // Author / Created By
      const authorFilters = normalizeArray(
        filter.createdById || filter.authorId,
      );
      const validAuthorIds = authorFilters.filter(isUuid);
      if (validAuthorIds.length === 1) {
        where.authorId = validAuthorIds[0];
      } else if (validAuthorIds.length > 1) {
        where.authorId = { in: validAuthorIds };
      }

      // Due date & Start date
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
        where.OR = [
          { title: { contains: query, mode: 'insensitive' } },
          { identifier: { contains: query, mode: 'insensitive' } },
        ];
      }
      if (filter.limit) take = filter.limit;
      if (filter.offset) skip = filter.offset;
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

    const records = await this.prismaService.workItem.findMany({
      where,
      include: BASE_WORK_ITEM_INCLUDE,
      orderBy,
      ...(take ? { take } : {}),
      ...(skip ? { skip } : {}),
    });

    if (this.prismaService.entityAttachment?.findMany && records.length > 0) {
      try {
        const itemIds = records.map((r) => r.id);
        const attachments = await this.prismaService.entityAttachment.findMany({
          where: {
            entityType: EntityType.work_item,
            entityId: { in: itemIds },
          },
          orderBy: { createdAt: 'asc' },
        });
        const attachmentMap = new Map<string, RawAttachmentRecord[]>();
        for (const att of attachments) {
          const list = attachmentMap.get(att.entityId) || [];
          list.push(att);
          attachmentMap.set(att.entityId, list);
        }
        for (const r of records) {
          const itemAtts = attachmentMap.get(r.id);
          if (itemAtts && itemAtts.length > 0) {
            (
              r as WorkItemWithRelations & { attachments?: WorkItemAttachments }
            ).attachments = this.formatEntityAttachments(itemAtts);
          }
        }
      } catch {
        // Graceful fallback if table is unavailable in mocks
      }
    }

    return records;
  }

  private formatEntityAttachments(
    records: RawAttachmentRecord[],
  ): WorkItemAttachments {
    const pages: NonNullable<WorkItemAttachments['pages']> = [];
    const papers: NonNullable<WorkItemAttachments['papers']> = [];
    const files: NonNullable<WorkItemAttachments['files']> = [];
    const links: NonNullable<WorkItemAttachments['links']> = [];

    const safeRecords = Array.isArray(records) ? records : [];
    for (const r of safeRecords) {
      const meta =
        r.metadata &&
        typeof r.metadata === 'object' &&
        !Array.isArray(r.metadata)
          ? (r.metadata as Record<string, unknown>)
          : {};
      const category =
        (typeof meta.category === 'string' ? meta.category : undefined) ||
        (r.mimeType === 'application/x-page'
          ? 'page'
          : r.mimeType === 'application/x-paper'
            ? 'paper'
            : r.mimeType === 'text/uri-list'
              ? 'link'
              : 'file');

      if (category === 'page') {
        pages.push({
          id: r.id,
          title:
            typeof meta.title === 'string'
              ? meta.title
              : r.filename || 'Untitled Page',
          slug: typeof meta.slug === 'string' ? meta.slug : null,
          addedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      } else if (category === 'paper') {
        papers.push({
          id: r.id,
          title:
            typeof meta.title === 'string'
              ? meta.title
              : r.filename || 'Untitled Paper',
          doi: typeof meta.doi === 'string' ? meta.doi : null,
          citationKey:
            typeof meta.citationKey === 'string' ? meta.citationKey : null,
          addedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      } else if (category === 'link') {
        links.push({
          title:
            typeof meta.title === 'string' ? meta.title : r.filename || 'Link',
          url: r.url || '',
          addedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      } else {
        files.push({
          id: r.id,
          name: r.filename || 'file',
          url: r.url || '',
          size: typeof r.size === 'number' ? r.size : null,
          type: r.mimeType || 'application/octet-stream',
          uploadedAt: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : new Date().toISOString(),
        });
      }
    }

    return { pages, papers, files, links };
  }

  async findWorkItemsByAssignee(
    userId: string,
    projectId?: string,
    take?: number,
    skip?: number,
  ): Promise<WorkItemWithRelations[]> {
    const where: Prisma.WorkItemWhereInput = {
      assigneeId: userId,
      deletedAt: null,
      archivedAt: null,
    };

    if (projectId) {
      const canonicalProjectId =
        await this.resolveCanonicalProjectId(projectId);
      if (canonicalProjectId) {
        where.projectId = canonicalProjectId;
      }
    }

    return this.prismaService.workItem.findMany({
      where,
      include: BASE_WORK_ITEM_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { rank: 'asc' }],
      ...(take ? { take } : {}),
      ...(skip ? { skip } : {}),
    });
  }

  async findProjectWithColumns(projectId: string) {
    const where = isUuid(projectId)
      ? { id: projectId, deletedAt: null }
      : {
          identifier: { equals: projectId, mode: 'insensitive' as const },
          deletedAt: null,
        };
    return this.prismaService.project.findFirst({
      where,
      select: {
        id: true,
        name: true,
        states: {
          orderBy: { sequence: 'asc' },
        },
      },
    });
  }

  async findWorkItemById(
    workItemId: string,
  ): Promise<WorkItemWithRelations | null> {
    const item = !isUuid(workItemId)
      ? await this.prismaService.workItem.findFirst({
          where: { identifier: workItemId, deletedAt: null },
          include: BASE_WORK_ITEM_INCLUDE,
        })
      : await this.prismaService.workItem.findFirst({
          where: { id: workItemId, deletedAt: null },
          include: BASE_WORK_ITEM_INCLUDE,
        });

    if (!item) return null;

    if (this.prismaService.entityAttachment?.findMany) {
      try {
        const records = await this.prismaService.entityAttachment.findMany({
          where: {
            entityType: EntityType.work_item,
            entityId: item.id,
          },
          orderBy: { createdAt: 'asc' },
        });
        if (records && records.length > 0) {
          (
            item as WorkItemWithRelations & {
              attachments?: WorkItemAttachments;
            }
          ).attachments = this.formatEntityAttachments(records);
        }
      } catch {
        // Graceful fallback
      }
    }

    return item;
  }

  async findWorkItemByIdentifier(
    projectId: string,
    identifier: string,
  ): Promise<WorkItemWithRelations | null> {
    return this.prismaService.workItem.findFirst({
      where: { projectId, identifier, deletedAt: null },
      include: BASE_WORK_ITEM_INCLUDE,
    });
  }

  async countColumnWorkItems(
    projectId: string,
    columnId: string,
  ): Promise<number> {
    return this.prismaService.workItem.count({
      where: { projectId, columnId, deletedAt: null, archivedAt: null },
    });
  }

  async countProjectWorkItems(projectId: string): Promise<number> {
    return this.prismaService.workItem.count({
      where: { projectId, deletedAt: null, archivedAt: null },
    });
  }

  async createWorkItem(
    data: Prisma.WorkItemCreateInput | Prisma.WorkItemUncheckedCreateInput,
  ): Promise<WorkItemWithRelations> {
    const { columnId, ...restData } = data as (
      Prisma.WorkItemCreateInput | Prisma.WorkItemUncheckedCreateInput
    ) & { columnId?: string };
    const createData = { ...restData };
    const hasRelationConnect = Boolean(
      (createData as Prisma.WorkItemCreateInput).project?.connect ||
      (createData as Prisma.WorkItemCreateInput).author?.connect ||
      (createData as Prisma.WorkItemCreateInput).assignee?.connect ||
      (createData as Prisma.WorkItemCreateInput).parentWorkItem?.connect ||
      (createData as Prisma.WorkItemCreateInput).state?.connect,
    );

    if (columnId && hasRelationConnect) {
      if (!(createData as Prisma.WorkItemCreateInput).state) {
        (createData as Prisma.WorkItemCreateInput).state = {
          connect: { id: columnId },
        };
      }
    } else if (columnId) {
      (createData as Prisma.WorkItemUncheckedCreateInput).columnId = columnId;
    }

    return this.executeTx<WorkItemWithRelations>(async (tx) => {
      const created = await tx.workItem.create({
        data: createData as Prisma.WorkItemCreateInput,
        include: BASE_WORK_ITEM_INCLUDE,
      });

      // Dual-write assignees
      const assigneeIdsToSync: string[] = [];
      if (created.assigneeId) assigneeIdsToSync.push(created.assigneeId);
      if (Array.isArray(created.assigneeIds)) {
        created.assigneeIds.forEach((id: unknown) => {
          if (typeof id === 'string' && id && !assigneeIdsToSync.includes(id)) {
            assigneeIdsToSync.push(id);
          }
        });
      }

      if (assigneeIdsToSync.length > 0 && tx.workItemAssignee) {
        await tx.workItemAssignee.createMany({
          data: assigneeIdsToSync.map((userId) => ({
            workItemId: created.id,
            userId,
            isPrimary: userId === created.assigneeId,
          })),
          skipDuplicates: true,
        });
      }

      // Dual-write labels
      if (
        Array.isArray(created.labels) &&
        created.labels.length > 0 &&
        tx.workItemLabel &&
        tx.workItemLabelAssignment
      ) {
        const projectLabels = await tx.workItemLabel.findMany({
          where: { projectId: created.projectId },
        });

        const labelNameToId = new Map<string, string>();
        for (const pl of projectLabels) {
          labelNameToId.set(pl.name.toLowerCase(), pl.id);
        }

        const labelsToAssign: string[] = [];
        for (const labelName of created.labels) {
          const lower = labelName.toLowerCase();
          const existingId = labelNameToId.get(lower);
          if (existingId) {
            labelsToAssign.push(existingId);
          } else {
            const newLabel = await tx.workItemLabel.create({
              data: {
                projectId: created.projectId,
                name: labelName,
                color: '#6B7280',
                createdById: created.authorId,
              },
            });
            labelNameToId.set(lower, newLabel.id);
            labelsToAssign.push(newLabel.id);
          }
        }

        if (labelsToAssign.length > 0) {
          await tx.workItemLabelAssignment.createMany({
            data: labelsToAssign.map((labelId) => ({
              workItemId: created.id,
              labelId,
            })),
            skipDuplicates: true,
          });
        }
      }

      return created;
    });
  }

  async updateWorkItem(
    workItemId: string,
    data: Prisma.WorkItemUpdateInput | Prisma.WorkItemUncheckedUpdateInput,
  ): Promise<WorkItemWithRelations> {
    const { columnId, ...restData } = data as (
      Prisma.WorkItemUpdateInput | Prisma.WorkItemUncheckedUpdateInput
    ) & { columnId?: string; assigneeId?: string };
    const updateData = { ...restData };
    const hasRelationConnect = Boolean(
      (updateData as Prisma.WorkItemUpdateInput).assignee?.connect ||
      (updateData as Prisma.WorkItemUpdateInput).assignee?.disconnect ||
      (updateData as Prisma.WorkItemUpdateInput).parentWorkItem?.connect ||
      (updateData as Prisma.WorkItemUpdateInput).parentWorkItem?.disconnect ||
      (updateData as Prisma.WorkItemUpdateInput).state?.connect,
    );

    if (columnId && hasRelationConnect) {
      if (!(updateData as Prisma.WorkItemUpdateInput).state) {
        (updateData as Prisma.WorkItemUpdateInput).state = {
          connect: { id: columnId },
        };
      }
    } else if (columnId) {
      (updateData as Prisma.WorkItemUncheckedUpdateInput).columnId = columnId;
    }

    return this.executeTx<WorkItemWithRelations>(async (tx) => {
      const updated = await tx.workItem.update({
        where: { id: workItemId },
        data: updateData as any,
        include: BASE_WORK_ITEM_INCLUDE,
      });

      // Dual-write assignees if updated
      const rawData = data as Record<string, unknown>;
      if (
        (rawData.assigneeId !== undefined ||
          rawData.assigneeIds !== undefined ||
          rawData.assignee !== undefined) &&
        tx.workItemAssignee
      ) {
        const assigneeIdsToSync: string[] = [];
        if (updated.assigneeId) assigneeIdsToSync.push(updated.assigneeId);
        if (Array.isArray(updated.assigneeIds)) {
          updated.assigneeIds.forEach((id: unknown) => {
            if (
              typeof id === 'string' &&
              id &&
              !assigneeIdsToSync.includes(id)
            ) {
              assigneeIdsToSync.push(id);
            }
          });
        }

        await tx.workItemAssignee.deleteMany({
          where: { workItemId },
        });

        if (assigneeIdsToSync.length > 0) {
          await tx.workItemAssignee.createMany({
            data: assigneeIdsToSync.map((userId) => ({
              workItemId,
              userId,
              isPrimary: userId === updated.assigneeId,
            })),
            skipDuplicates: true,
          });
        }
      }

      // Dual-write labels if updated - batched to eliminate N+1 queries
      if (
        updateData.labels !== undefined &&
        Array.isArray(updated.labels) &&
        tx.workItemLabel &&
        tx.workItemLabelAssignment
      ) {
        await tx.workItemLabelAssignment.deleteMany({
          where: { workItemId },
        });

        const rawLabels: unknown[] = Array.isArray(updated.labels)
          ? updated.labels
          : [];
        const uniqueLabelNames: string[] = Array.from(
          new Set(
            rawLabels
              .filter(
                (l: unknown): l is string =>
                  typeof l === 'string' && Boolean(l.trim()),
              )
              .map((l: string) => l.trim()),
          ),
        );

        if (uniqueLabelNames.length > 0) {
          const existingLabels = await tx.workItemLabel.findMany({
            where: {
              projectId: updated.projectId,
              name: { in: uniqueLabelNames, mode: 'insensitive' },
            },
          });

          const existingMap = new Map<string, (typeof existingLabels)[0]>(
            existingLabels.map((l) => [l.name.toLowerCase(), l]),
          );

          const missingNames: string[] = uniqueLabelNames.filter(
            (name: string) => !existingMap.has(name.toLowerCase()),
          );

          if (missingNames.length > 0) {
            await tx.workItemLabel.createMany({
              data: missingNames.map((name: string) => ({
                name,
                projectId: updated.projectId,
                createdById: updated.authorId,
              })),
              skipDuplicates: true,
            });
          }

          const allLabels = await tx.workItemLabel.findMany({
            where: {
              projectId: updated.projectId,
              name: { in: uniqueLabelNames, mode: 'insensitive' },
            },
          });

          if (allLabels.length > 0) {
            await tx.workItemLabelAssignment.createMany({
              data: allLabels.map((label) => ({
                workItemId,
                labelId: label.id,
              })),
              skipDuplicates: true,
            });
          }
        }
      }

      return updated;
    });
  }

  async softDeleteWorkItem(workItemId: string): Promise<WorkItem> {
    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: { deletedAt: new Date() },
    });
  }

  async restoreWorkItem(workItemId: string): Promise<WorkItem> {
    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: { deletedAt: null },
    });
  }

  async deleteWorkItem(workItemId: string): Promise<WorkItem> {
    return this.prismaService.workItem.delete({
      where: { id: workItemId },
    });
  }

  async findColumnWorkItems(projectId: string, columnId: string) {
    return this.prismaService.workItem.findMany({
      where: { projectId, columnId, deletedAt: null },
      orderBy: { rank: 'asc' },
    });
  }

  async updateWorkItemsRank(
    updates: Array<{
      id: string;
      rank: number;
      columnId?: string;
      completed?: boolean;
    }>,
  ): Promise<WorkItem[]> {
    const validUpdates = updates.filter((updateItem) => isUuid(updateItem.id));
    if (validUpdates.length === 0) return [];
    return this.prismaService.$transaction(
      validUpdates.map((updateItem) =>
        this.prismaService.workItem.update({
          where: { id: updateItem.id },
          data: {
            rank: updateItem.rank,
            ...(updateItem.columnId && { columnId: updateItem.columnId }),
            ...(updateItem.completed !== undefined && {
              completed: updateItem.completed,
            }),
          },
        }),
      ),
    );
  }

  async findWorkItemsByIds(workItemIds: string[]): Promise<WorkItem[]> {
    const validIds = workItemIds.filter(isUuid);
    if (validIds.length === 0) return [];
    return this.prismaService.workItem.findMany({
      where: { id: { in: validIds }, deletedAt: null },
    });
  }

  async bulkUpdateWorkItems(
    projectId: string,
    workItemIds: string[],
    data: Prisma.WorkItemUpdateManyMutationInput,
  ) {
    const validIds = workItemIds.filter(isUuid);
    if (validIds.length === 0 || !projectId || !isUuid(projectId)) {
      return { count: 0 };
    }
    return this.prismaService.workItem.updateMany({
      where: {
        id: { in: validIds },
        projectId,
      },
      data,
    });
  }

  async bulkDeleteWorkItems(projectId: string, workItemIds: string[]) {
    const validIds = workItemIds.filter(isUuid);
    if (validIds.length === 0 || !projectId || !isUuid(projectId)) {
      return { count: 0 };
    }
    return this.prismaService.workItem.updateMany({
      where: {
        id: { in: validIds },
        projectId,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async findProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    const project = isUuid(projectId)
      ? await this.prismaService.project.findUnique({
          where: { id: projectId },
          select: { id: true, createdById: true },
        })
      : await this.prismaService.project.findFirst({
          where: {
            identifier: { equals: projectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true, createdById: true },
        });

    if (!project) return null;

    if (project.createdById === userId) {
      return 'owner';
    }

    const member = await this.prismaService.projectMember.findFirst({
      where: {
        projectId: project.id,
        userId,
      },
      select: { role: true },
    });

    return member?.role ?? null;
  }

  async saveInitialAttachments(
    workItemId: string,
    projectId: string,
    authorId: string,
    attachments: WorkItemAttachments | Record<string, unknown>,
  ): Promise<void> {
    if (!attachments || typeof attachments !== 'object') return;
    const records: Prisma.EntityAttachmentCreateManyInput[] = [];

    if (Array.isArray(attachments.pages)) {
      for (const p of attachments.pages) {
        if (p?.pageId || p?.id) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: p.title || 'Untitled Page',
            url: `/pages/${p.pageId || p.id}`,
            mimeType: 'application/x-page',
            size: 0,
            metadata: {
              category: 'page',
              pageId: p.pageId || p.id,
              title: p.title,
            },
          });
        }
      }
    }

    if (Array.isArray(attachments.papers)) {
      for (const p of attachments.papers) {
        if (p?.paperId || p?.id) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: p.title || 'Untitled Paper',
            url: p.doi ? `https://doi.org/${p.doi}` : '',
            mimeType: 'application/x-paper',
            size: 0,
            metadata: {
              category: 'paper',
              paperId: p.paperId || p.id,
              title: p.title,
              doi: p.doi,
              citationKey: p.citationKey,
            },
          });
        }
      }
    }

    if (Array.isArray(attachments.files)) {
      for (const f of attachments.files) {
        if (f?.url) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: f.name || 'file',
            url: f.url,
            mimeType: f.type || 'application/octet-stream',
            size: typeof f.size === 'number' ? f.size : 0,
            metadata: { category: 'file', name: f.name },
          });
        }
      }
    }

    if (Array.isArray(attachments.links)) {
      for (const l of attachments.links) {
        if (l?.url) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: l.title || l.url,
            url: l.url,
            mimeType: 'text/uri-list',
            size: 0,
            metadata: { category: 'link', url: l.url, title: l.title },
          });
        }
      }
    }

    if (records.length > 0) {
      await this.prismaService.entityAttachment.createMany({
        data: records,
      });
    }
  }

  async syncAttachments(
    workItemId: string,
    projectId: string,
    authorId?: string,
    attachments?: WorkItemAttachments | Record<string, unknown>,
  ): Promise<void> {
    if (
      !attachments ||
      typeof attachments !== 'object' ||
      !this.prismaService.entityAttachment
    ) {
      return;
    }

    const records: Prisma.EntityAttachmentCreateManyInput[] = [];

    if (Array.isArray(attachments.pages)) {
      for (const p of attachments.pages) {
        const pageId = p?.pageId || p?.id;
        if (pageId) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: p.title || 'Untitled Page',
            url: `/pages/${pageId}`,
            mimeType: 'application/x-page',
            size: 0,
            metadata: {
              category: 'page',
              pageId,
              title: p.title,
            },
          });
        }
      }
    }

    if (Array.isArray(attachments.papers)) {
      for (const p of attachments.papers) {
        const paperId = p?.paperId || p?.id;
        if (paperId) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: p.title || 'Untitled Paper',
            url: p.doi ? `https://doi.org/${p.doi}` : '',
            mimeType: 'application/x-paper',
            size: 0,
            metadata: {
              category: 'paper',
              paperId,
              title: p.title,
              doi: p.doi,
              citationKey: p.citationKey,
            },
          });
        }
      }
    }

    if (Array.isArray(attachments.files)) {
      for (const f of attachments.files) {
        if (f?.url) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: f.name || f.filename || 'file',
            url: f.url,
            mimeType: f.type || f.mimeType || 'application/octet-stream',
            size: typeof f.size === 'number' ? f.size : 0,
            metadata: {
              category: 'file',
              name: f.name || f.filename,
              ...(f.fileId ? { fileId: f.fileId } : {}),
            },
          });
        }
      }
    }

    if (Array.isArray(attachments.links)) {
      for (const l of attachments.links) {
        if (l?.url) {
          records.push({
            entityType: EntityType.work_item,
            entityId: workItemId,
            projectId,
            authorId,
            filename: l.title || l.url,
            url: l.url,
            mimeType: 'text/uri-list',
            size: 0,
            metadata: { category: 'link', url: l.url, title: l.title },
          });
        }
      }
    }

    await this.executeTx(async (tx) => {
      await tx.entityAttachment.deleteMany({
        where: {
          entityType: EntityType.work_item,
          entityId: workItemId,
        },
      });

      if (records.length > 0) {
        await tx.entityAttachment.createMany({
          data: records,
        });
      }
    });
  }

  async disconnectParentWorkItem(
    workItemId: string,
  ): Promise<WorkItemWithRelations> {
    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: { parentWorkItem: { disconnect: true } },
      include: BASE_WORK_ITEM_INCLUDE,
    });
  }

  async findLabelsByIds(
    projectId: string | string[],
    labelIds: string[],
  ): Promise<Array<{ id: string; name: string; color: string }>> {
    if (!labelIds.length) return [];
    const uniqueInputs = Array.from(new Set(labelIds.filter(Boolean)));
    if (!uniqueInputs.length) return [];

    const uuids = uniqueInputs.filter((id) => isUuid(id));
    const names = uniqueInputs.filter((id) => !isUuid(id));

    const orConditions: Prisma.WorkItemLabelWhereInput[] = [];
    if (uuids.length > 0) {
      orConditions.push({ id: { in: uuids } });
    }
    if (names.length > 0) {
      orConditions.push({ name: { in: names } });
    }

    if (orConditions.length === 0) return [];

    const projectFilter = Array.isArray(projectId)
      ? { in: projectId }
      : projectId;

    return this.prismaService.workItemLabel.findMany({
      where: {
        AND: [
          { projectId: projectFilter },
          orConditions.length === 1 ? orConditions[0] : { OR: orConditions },
        ],
      },
      select: { id: true, name: true, color: true },
    });
  }

  async findStateById(stateId: string) {
    if (!isUuid(stateId)) return null;
    return this.prismaService.workItemState.findUnique({
      where: { id: stateId },
      select: {
        id: true,
        name: true,
        color: true,
        group: true,
        sequence: true,
        isDefault: true,
        projectId: true,
      },
    });
  }

  async getStateGroupCounts(
    projectId: string,
  ): Promise<Record<string, number>> {
    const workItems = await this.prismaService.workItem.findMany({
      where: {
        projectId,
        deletedAt: null,
      },
      select: {
        state: {
          select: { group: true },
        },
      },
    });

    const counts: Record<string, number> = {
      backlog: 0,
      unstarted: 0,
      started: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const item of workItems) {
      const group = item.state?.group || 'backlog';
      counts[group] = (counts[group] || 0) + 1;
    }

    return counts;
  }

  async getOverdueCount(projectId: string): Promise<number> {
    const now = new Date();
    return this.prismaService.workItem.count({
      where: {
        projectId,
        deletedAt: null,
        dueDate: { lt: now },
        state: {
          group: {
            notIn: ['completed', 'cancelled'],
          },
        },
      },
    });
  }

  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    const role = await this.findProjectMemberRole(projectId, userId);
    return role !== null;
  }

  async findProjectPrefix(projectId: string): Promise<string> {
    const where = isUuid(projectId)
      ? { id: projectId, deletedAt: null }
      : {
          identifier: { equals: projectId, mode: 'insensitive' as const },
          deletedAt: null,
        };

    const project = await this.prismaService.project
      .findFirst({
        where,
        select: { identifier: true, name: true },
      })
      .catch(() => null);

    return deriveProjectIdentifierPrefix(project?.identifier, project?.name);
  }

  async getMaxSequence(projectId: string): Promise<number> {
    const lastWorkItem = await this.prismaService.workItem.findFirst({
      where: { projectId },
      orderBy: { sequenceNumber: 'desc' },
      select: { sequenceNumber: true },
    });

    if (lastWorkItem?.sequenceNumber) {
      return lastWorkItem.sequenceNumber;
    }

    const project = await this.prismaService.project
      .findUnique({
        where: { id: projectId },
        select: { workItemSequence: true },
      })
      .catch(() => null);

    return project?.workItemSequence ?? 0;
  }

  async findStateWithGroup(stateId: string) {
    return this.prismaService.workItemState.findUnique({
      where: { id: stateId },
      select: { group: true, name: true },
    });
  }

  async findProjectStates(projectId: string) {
    return this.prismaService.workItemState.findMany({
      where: { projectId },
      orderBy: { sequence: 'asc' },
    });
  }
}

export const WorkItemRepository = CoreRepository;
export type WorkItemRepository = CoreRepository;
