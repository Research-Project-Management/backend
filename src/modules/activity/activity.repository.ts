import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { DomainActivityEvent } from './events/activity.events';
import { EntityType } from '@prisma/client';

const ACTOR_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class ActivityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(event: DomainActivityEvent) {
    return this.prisma.activityEvent.create({
      data: {
        entityType: event.entityType,
        entityId: event.entityId,
        verb: event.verb,
        field: event.field,
        oldValue: event.oldValue,
        newValue: event.newValue,
        oldIdentifier: event.oldIdentifier,
        newIdentifier: event.newIdentifier,
        actorId: event.actorId,
        workspaceId: event.workspaceId,
        projectId: event.projectId,
      },
    });
  }

  async findWorkspaceFeed(
    workspaceId: string,
    options?: {
      projectId?: string;
      entityType?: EntityType;
      limit?: number;
      offset?: number;
    },
  ) {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const where: any = { workspaceId };
    if (options?.projectId) {
      where.projectId = options.projectId;
    }
    if (options?.entityType) {
      where.entityType = options.entityType;
    }

    const [items, total] = await Promise.all([
      this.prisma.activityEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          actor: { select: ACTOR_SELECT },
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.activityEvent.count({ where }),
    ]);

    return { items, total };
  }

  async findEntityFeed(entityType: EntityType, entityId: string, limit = 50) {
    return this.prisma.activityEvent.findMany({
      where: {
        entityType,
        entityId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: { select: ACTOR_SELECT },
      },
    });
  }

  async findRecentByActor(workspaceId: string, actorId: string, limit = 50) {
    return this.prisma.activityEvent.findMany({
      where: {
        workspaceId,
        actorId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
