import { Injectable } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { EntityType } from '@prisma/client';

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
  T extends
    | {
        id: string;
        email: string | null;
        profile?: { name: string; avatar: string | null } | null;
      }
    | null
    | undefined,
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
}
