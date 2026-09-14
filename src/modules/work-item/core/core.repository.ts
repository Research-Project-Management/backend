import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUuid } from '@/core/utils/uuid.util';
import { Prisma, WorkItem } from '@prisma/client';
import {
  IWorkItemRepository,
  WorkItemWithRelations,
  WorkItemFilterOptions,
  WorkItemAttachments,
  USER_MINIMAL_SELECT,
  CYCLE_SELECT,
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
        if (filter.parentWorkItemId === 'none' || filter.parentWorkItemId === 'null') {
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
      select: { id: true, name: true, workItemColumns: true },
    });
  }

  async findWorkItemById(workItemId: string): Promise<WorkItemWithRelations | null> {
    if (!isUuid(workItemId)) {
      return this.prismaService.workItem.findFirst({
        where: { identifier: workItemId, deletedAt: null },
        include: {
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

    return this.prismaService.workItem.findFirst({
      where: { id: workItemId, deletedAt: null },
      include: {
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

  async countColumnWorkItems(projectId: string, columnId: string): Promise<number> {
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
    return this.prismaService.workItem.create({
      data: data as Prisma.WorkItemCreateInput,
      include: {
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
    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: data,
      include: {
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

  async updateAttachments(
    workItemId: string,
    attachments: WorkItemAttachments,
  ): Promise<WorkItem> {
    return (this.prismaService.workItem as any).update({
      where: { id: workItemId },
      data: { attachments: attachments as any },
    });
  }

  async disconnectParentWorkItem(workItemId: string): Promise<WorkItemWithRelations> {
    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: { parentWorkItem: { disconnect: true } },
      include: {
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
}

export const WorkItemRepository = CoreRepository;
export type WorkItemRepository = CoreRepository;
