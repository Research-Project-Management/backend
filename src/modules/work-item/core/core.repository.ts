import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUuid } from '@/core/utils/uuid.util';
import { Prisma, WorkItem, EntityType } from '@prisma/client';
import {
  IWorkItemRepository,
  WorkItemWithRelations,
  WorkItemFilterOptions,
  WorkItemAttachments,
  USER_MINIMAL_SELECT,
  CYCLE_SELECT,
  STATE_MINIMAL_SELECT,
  CHILD_WORK_ITEM_SELECT,
} from './types/work-item.types';
import { deriveProjectIdentifierPrefix } from './utils/work-item.util';

@Injectable()
export class CoreRepository implements IWorkItemRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async nextProjectWorkItemIdentifier(
    projectId: string,
  ): Promise<{ identifier: string; sequenceNumber: number }> {
    try {
      const project = await this.prismaService.project.update({
        where: { id: projectId },
        data: { workItemSequence: { increment: 1 } },
        select: { name: true, identifier: true, workItemSequence: true },
      });

      const prefix = deriveProjectIdentifierPrefix(
        project.identifier,
        project.name,
      );

      return {
        identifier: `${prefix}-${project.workItemSequence}`,
        sequenceNumber: project.workItemSequence,
      };
    } catch {
      const project = await this.prismaService.project.findUnique({
        where: { id: projectId },
        select: { identifier: true, name: true },
      });
      const prefix = deriveProjectIdentifierPrefix(
        project?.identifier,
        project?.name,
      );

      const lastWorkItem = await this.prismaService.workItem.findFirst({
        where: { projectId },
        orderBy: { sequenceNumber: 'desc' },
        select: { sequenceNumber: true },
      });

      const sequenceNumber = (lastWorkItem?.sequenceNumber ?? 0) + 1;
      return { identifier: `${prefix}-${sequenceNumber}`, sequenceNumber };
    }
  }

  async findProjectWorkItems(
    projectId: string,
    filter?: string | WorkItemFilterOptions,
  ): Promise<WorkItemWithRelations[]> {
    let canonicalProjectId = projectId;
    if (!isUuid(canonicalProjectId)) {
      const project = await this.prismaService.project
        .findFirst({
          where: {
            identifier: { equals: canonicalProjectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        })
        .catch(() => null);
      if (!project) return [];
      canonicalProjectId = project.id;
    }

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

    if (typeof filter === 'string') {
      if (filter === 'none' || filter === 'null' || filter === 'unassigned') {
        where.cycleId = null;
      } else if (isUuid(filter)) {
        where.cycleId = filter;
      }
    } else if (filter) {
      if (filter.cycleId !== undefined) {
        if (
          filter.cycleId === 'none' ||
          filter.cycleId === 'null' ||
          filter.cycleId === 'unassigned'
        ) {
          where.cycleId = null;
        } else if (filter.cycleId === null || isUuid(filter.cycleId)) {
          where.cycleId = filter.cycleId;
        }
      }
      if (filter.columnId) where.columnId = filter.columnId;
      if (filter.priority) where.priority = filter.priority;
      if (filter.assigneeId !== undefined) {
        if (
          filter.assigneeId === 'unassigned' ||
          filter.assigneeId === 'none' ||
          filter.assigneeId === 'null'
        ) {
          where.assigneeId = null;
        } else if (filter.assigneeId === null || isUuid(filter.assigneeId)) {
          where.assigneeId = filter.assigneeId;
        }
      }
      if (filter.parentWorkItemId !== undefined) {
        if (
          filter.parentWorkItemId === 'none' ||
          filter.parentWorkItemId === 'null'
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

    return this.prismaService.workItem.findMany({
      where,
      include: {
        state: { select: STATE_MINIMAL_SELECT },
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          where: { deletedAt: null },
          select: CHILD_WORK_ITEM_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true } },
      },
      orderBy: { rank: 'asc' },
      ...(take ? { take } : {}),
      ...(skip ? { skip } : {}),
    });
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
      let canonicalProjectId = projectId;
      if (!isUuid(canonicalProjectId)) {
        const project = await this.prismaService.project
          .findFirst({
            where: {
              identifier: { equals: canonicalProjectId, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          })
          .catch(() => null);
        if (project) {
          canonicalProjectId = project.id;
        }
      }
      where.projectId = canonicalProjectId;
    }

    return this.prismaService.workItem.findMany({
      where,
      include: {
        state: { select: STATE_MINIMAL_SELECT },
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          where: { deletedAt: null },
          select: CHILD_WORK_ITEM_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { rank: 'asc' }],
      ...(take ? { take } : {}),
      ...(skip ? { skip } : {}),
    });
  }

  async findProjectWithColumns(projectId: string) {
    return this.prismaService.project.findFirst({
      where: { id: projectId, deletedAt: null },
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
    if (!isUuid(workItemId)) {
      return this.prismaService.workItem.findFirst({
        where: { identifier: workItemId, deletedAt: null },
        include: {
          state: { select: STATE_MINIMAL_SELECT },
          assignee: { select: USER_MINIMAL_SELECT },
          cycle: { select: CYCLE_SELECT },
          parentWorkItem: {
            select: { id: true, title: true, identifier: true },
          },
          childWorkItems: {
            where: { deletedAt: null },
            select: CHILD_WORK_ITEM_SELECT,
            orderBy: { rank: 'asc' },
          },
          project: { select: { id: true } },
        },
      });
    }

    return this.prismaService.workItem.findFirst({
      where: { id: workItemId, deletedAt: null },
      include: {
        state: { select: STATE_MINIMAL_SELECT },
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          where: { deletedAt: null },
          select: CHILD_WORK_ITEM_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true } },
      },
    });
  }

  async findWorkItemByIdentifier(
    projectId: string,
    identifier: string,
  ): Promise<WorkItemWithRelations | null> {
    return this.prismaService.workItem.findFirst({
      where: { projectId, identifier, deletedAt: null },
      include: {
        state: { select: STATE_MINIMAL_SELECT },
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          where: { deletedAt: null },
          select: CHILD_WORK_ITEM_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true } },
      },
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
    const createData = { ...(data as any) };
    const hasRelationConnect = Boolean(
      createData.project?.connect ||
      createData.author?.connect ||
      createData.assignee?.connect ||
      createData.cycle?.connect ||
      createData.parentWorkItem?.connect ||
      createData.state?.connect,
    );

    if (createData.columnId && hasRelationConnect) {
      if (!createData.state) {
        createData.state = { connect: { id: createData.columnId } };
      }
      delete createData.columnId;
    }

    return this.prismaService.workItem.create({
      data: createData,
      include: {
        state: { select: STATE_MINIMAL_SELECT },
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          where: { deletedAt: null },
          select: CHILD_WORK_ITEM_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true } },
      },
    });
  }

  async updateWorkItem(
    workItemId: string,
    data: Prisma.WorkItemUpdateInput | Prisma.WorkItemUncheckedUpdateInput,
  ): Promise<WorkItemWithRelations> {
    const updateData = { ...(data as any) };
    const hasRelationConnect = Boolean(
      updateData.assignee?.connect ||
      updateData.assignee?.disconnect ||
      updateData.cycle?.connect ||
      updateData.cycle?.disconnect ||
      updateData.parentWorkItem?.connect ||
      updateData.parentWorkItem?.disconnect ||
      updateData.state?.connect,
    );

    if (updateData.columnId && hasRelationConnect) {
      if (!updateData.state) {
        updateData.state = { connect: { id: updateData.columnId } };
      }
      delete updateData.columnId;
    }

    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: updateData,
      include: {
        state: { select: STATE_MINIMAL_SELECT },
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          where: { deletedAt: null },
          select: CHILD_WORK_ITEM_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true } },
      },
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
    attachments: any,
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

  async disconnectParentWorkItem(
    workItemId: string,
  ): Promise<WorkItemWithRelations> {
    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: { parentWorkItem: { disconnect: true } },
      include: {
        state: { select: STATE_MINIMAL_SELECT },
        assignee: {
          select: USER_MINIMAL_SELECT,
        },
        cycle: {
          select: CYCLE_SELECT,
        },
        parentWorkItem: { select: { id: true, title: true, identifier: true } },
        childWorkItems: {
          where: { deletedAt: null },
          select: CHILD_WORK_ITEM_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true } },
      },
    });
  }

  async findLabelsByIds(
    projectId: string,
    labelIds: string[],
  ): Promise<Array<{ id: string; name: string; color: string }>> {
    if (!labelIds.length) return [];
    const uniqueIds = Array.from(new Set(labelIds.filter(Boolean)));
    if (!uniqueIds.length) return [];
    return this.prismaService.label.findMany({
      where: { id: { in: uniqueIds }, projectId },
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
      },
    });
  }
}

export const WorkItemRepository = CoreRepository;
export type WorkItemRepository = CoreRepository;
