import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType } from '@prisma/client';
import { isUuid } from '@/core/utils/uuid.util';

@Injectable()
export class HistoryRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async resolveWorkItemUuid(
    workItemIdOrIdentifier: string,
  ): Promise<string | null> {
    if (isUuid(workItemIdOrIdentifier)) {
      return workItemIdOrIdentifier;
    }
    const item = await this.prismaService.workItem.findFirst({
      where: {
        identifier: { equals: workItemIdOrIdentifier, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true },
    });
    return item?.id || null;
  }

  async findWorkItemWithProject(workItemId: string) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return null;
    return this.prismaService.workItem.findUnique({
      where: { id: itemUuid },
      select: {
        id: true,
        columnId: true,
        completed: true,
        createdAt: true,
        projectId: true,
        project: {
          select: {
            id: true,
            identifier: true,
            states: true,
          },
        },
      },
    });
  }

  async findWorkItemComments(
    workItemId: string,
    sort: 'asc' | 'desc' = 'desc',
  ) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    return this.prismaService.workItemComment.findMany({
      where: { workItemId: itemUuid },
      orderBy: { createdAt: sort },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findWorkItemActivityEvents(
    workItemId: string,
    sort: 'asc' | 'desc' = 'desc',
  ) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    return this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.work_item,
        entityId: itemUuid,
      },
      orderBy: { createdAt: sort },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findStateTransitions(workItemId: string) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    return this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.work_item,
        entityId: itemUuid,
        OR: [
          { verb: 'transitioned' },
          { field: 'state' },
          { field: 'columnId' },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findHistoryEvents(workItemId: string, sort: 'asc' | 'desc' = 'desc') {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    return this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.work_item,
        entityId: itemUuid,
        field: { not: null },
      },
      orderBy: { createdAt: sort },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }
}
