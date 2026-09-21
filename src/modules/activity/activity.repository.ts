import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUUID } from 'class-validator';
import { DomainActivityEvent } from './events/activity.events';
import { EntityType, ActivityEvent, Prisma } from '@prisma/client';
import {
  IActivityRepository,
  ActivityEventWithActor,
  ACTOR_MINIMAL_SELECT,
} from './types/activity-repository.interface';

function mapActivityEvent(event: any) {
  if (!event) return event;
  const actor = event.actor
    ? {
        id: event.actor.id,
        email: event.actor.email,
        name: event.actor.profile?.name ?? event.actor.name ?? 'User',
        avatar: event.actor.profile?.avatar ?? event.actor.avatar ?? null,
      }
    : event.actor;
  return {
    ...event,
    actor,
  };
}

@Injectable()
export class ActivityRepository implements IActivityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(event: DomainActivityEvent): Promise<ActivityEvent> {
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
        projectId: event.projectId,
      },
    });
  }

  async findProjectFeed(
    projectId: string,
    options?: {
      entityType?: EntityType;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ items: ActivityEventWithActor[]; total: number }> {
    if (!isUUID(projectId)) return { items: [], total: 0 };

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const where: any = { projectId };
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
          actor: { select: ACTOR_MINIMAL_SELECT },
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.activityEvent.count({ where }),
    ]);

    return { items: items.map(mapActivityEvent), total };
  }

  async findUserFeed(
    userId: string,
    options?: {
      projectId?: string;
      entityType?: EntityType;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ items: ActivityEventWithActor[]; total: number }> {
    if (options?.projectId && isUUID(options.projectId)) {
      return this.findProjectFeed(options.projectId, options);
    }
    if (!isUUID(userId)) return { items: [], total: 0 };

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const where: any = {
      OR: [{ actorId: userId }, { project: { members: { some: { userId } } } }],
    };
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
          actor: { select: ACTOR_MINIMAL_SELECT },
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.activityEvent.count({ where }),
    ]);

    return { items: items.map(mapActivityEvent), total };
  }

  async findEntityFeed(
    entityType: EntityType,
    entityId: string,
    limit = 50,
  ): Promise<ActivityEventWithActor[]> {
    if (!isUUID(entityId)) return [];
    const items = await this.prisma.activityEvent.findMany({
      where: {
        entityType,
        entityId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: { select: ACTOR_MINIMAL_SELECT },
        project: { select: { id: true, name: true } },
      },
    });
    return items.map(mapActivityEvent);
  }

  async findUserRecentEvents(
    actorId: string,
    limit = 50,
  ): Promise<ActivityEvent[]> {
    if (!isUUID(actorId)) return [];
    return this.prisma.activityEvent.findMany({
      where: { actorId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async findRecentByActor(
    actorId: string,
    limit = 50,
  ): Promise<ActivityEvent[]> {
    return this.findUserRecentEvents(actorId, limit);
  }

  /**
   * Batch-resolve titles for recent entities (work_item / paper / page).
   * Returns a Map<"type:id", title>.
   */
  async findEntitiesTitleMap(
    workItemIds: string[],
    paperIds: string[],
    pageIds: string[],
  ): Promise<Map<string, string>> {
    const validWorkItemIds = workItemIds.filter((id) => isUUID(id));
    const validPaperIds = paperIds.filter((id) => isUUID(id));
    const validPageIds = pageIds.filter((id) => isUUID(id));

    const [workItems, papers, pages] = await Promise.all([
      validWorkItemIds.length
        ? this.prisma.workItem.findMany({
            where: { id: { in: validWorkItemIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
      validPaperIds.length
        ? this.prisma.item.findMany({
            where: { id: { in: validPaperIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
      validPageIds.length
        ? this.prisma.page.findMany({
            where: { id: { in: validPageIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
    ]);

    const map = new Map<string, string>();
    workItems.forEach((t) => {
      map.set(`work_item:${t.id}`, t.title);
    });
    papers.forEach((p) => map.set(`paper:${p.id}`, p.title));
    pages.forEach((pg) => map.set(`page:${pg.id}`, pg.title));
    return map;
  }

  async findUserRecentItems(userId: string, limit: number) {
    if (!isUUID(userId)) {
      return { workItems: [], papers: [], pages: [] };
    }

    const [workItems, papers, pages] = await Promise.all([
      this.prisma.workItem.findMany({
        where: {
          deletedAt: null,
          OR: [{ authorId: userId }, { assigneeId: userId }],
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, projectId: true, updatedAt: true },
      }),
      this.prisma.item.findMany({
        where: {
          userId,
          deletedAt: null,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, updatedAt: true },
      }),
      this.prisma.page.findMany({
        where: {
          deletedAt: null,
          authorId: userId,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, projectId: true, updatedAt: true },
      }),
    ]);
    return { workItems, papers, pages };
  }

  async findWorkItemWithProject(workItemId: string) {
    return this.prisma.workItem.findUnique({
      where: { id: workItemId },
      select: {
        id: true,
        title: true,
        projectId: true,
        columnId: true,
        completed: true,
        createdAt: true,
        updatedAt: true,
        project: {
          select: {
            id: true,
            name: true,
            states: true,
          },
        },
      },
    });
  }

  async findWorkItemComments(workItemId: string, sort: 'asc' | 'desc' = 'asc') {
    const comments = await this.prisma.workItemComment.findMany({
      where: { workItemId },
      orderBy: { createdAt: sort },
      include: {
        author: { select: ACTOR_MINIMAL_SELECT },
      },
    });
    return comments.map((c: any) => ({
      ...c,
      author: c.author
        ? {
            id: c.author.id,
            email: c.author.email,
            name: c.author.profile?.name ?? c.author.name ?? 'User',
            avatar: c.author.profile?.avatar ?? c.author.avatar ?? null,
          }
        : c.author,
    }));
  }

  async findWorkItemActivityEvents(
    workItemId: string,
    sort: 'asc' | 'desc' = 'asc',
  ) {
    const items = await this.prisma.activityEvent.findMany({
      where: {
        entityType: EntityType.work_item,
        entityId: workItemId,
      },
      orderBy: { createdAt: sort },
      include: {
        actor: { select: ACTOR_MINIMAL_SELECT },
        project: { select: { id: true, name: true } },
      },
    });
    return items.map(mapActivityEvent);
  }
}
