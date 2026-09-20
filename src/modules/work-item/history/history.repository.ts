import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType } from '@prisma/client';
import { isUuid } from '@/core/utils/uuid.util';

const USER_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

function mapUser<
  T extends {
    id: string;
    email: string | null;
    profile?: { name: string; avatar: string | null } | null;
  } | null | undefined,
>(user: T) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.profile?.name ?? 'User',
    avatar: user.profile?.avatar ?? null,
  };
}

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
    const comments = await this.prismaService.workItemComment.findMany({
      where: { workItemId: itemUuid },
      orderBy: { createdAt: sort },
      include: {
        author: {
          select: USER_SELECT,
        },
      },
    });
    return comments.map((c) => ({
      ...c,
      author: mapUser(c.author),
    }));
  }

  async findWorkItemActivityEvents(
    workItemId: string,
    sort: 'asc' | 'desc' = 'desc',
  ) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    const events = await this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.work_item,
        entityId: itemUuid,
      },
      orderBy: { createdAt: sort },
      include: {
        actor: {
          select: USER_SELECT,
        },
      },
    });
    return events.map((e) => ({
      ...e,
      actor: mapUser(e.actor),
    }));
  }

  async findStateTransitions(workItemId: string) {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    const events = await this.prismaService.activityEvent.findMany({
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
          select: USER_SELECT,
        },
      },
    });
    return events.map((e) => ({
      ...e,
      actor: mapUser(e.actor),
    }));
  }

  async findHistoryEvents(workItemId: string, sort: 'asc' | 'desc' = 'desc') {
    const itemUuid = await this.resolveWorkItemUuid(workItemId);
    if (!itemUuid) return [];
    const events = await this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.work_item,
        entityId: itemUuid,
        field: { not: null },
      },
      orderBy: { createdAt: sort },
      include: {
        actor: {
          select: USER_SELECT,
        },
      },
    });
    return events.map((e) => ({
      ...e,
      actor: mapUser(e.actor),
    }));
  }
}
