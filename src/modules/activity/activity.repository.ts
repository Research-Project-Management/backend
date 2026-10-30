import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import { DomainActivityEvent } from './events/activity.events';
import { EntityType, ActivityEvent, Prisma } from '@prisma/client';
import {
  IActivityRepository,
  ActivityEventWithActor,
  ACTOR_MINIMAL_SELECT,
} from './types/activity-repository.interface';

type RawActivityEventWithActor = Prisma.ActivityEventGetPayload<{
  include: {
    actor: { select: typeof ACTOR_MINIMAL_SELECT };
    project: { select: { id: true; name: true } };
  };
}>;

function mapActivityEvent(
  event: RawActivityEventWithActor,
): ActivityEventWithActor {
  if (!event) return event;
  const actor = event.actor
    ? {
        id: event.actor.id,
        email: event.actor.email,
        name: event.actor.profile?.name ?? 'User',
        avatar: event.actor.profile?.avatar ?? null,
      }
    : null;
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

    const where: Prisma.ActivityEventWhereInput = { projectId };
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

    const where: Prisma.ActivityEventWhereInput = {
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

  async findRecentByActor(
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

  /**
   * Batch-resolve titles for recent entities (work_item / paper / page).
   * Returns a Map<"type:id", title>.
   */
  async findEntitiesTitleMap(
    workItemIds: string[],
    paperIds: string[],
    pageIds: string[],
    fileIds: string[] = [],
    projectIds: string[] = [],
  ): Promise<{
    titleMap: Map<string, string>;
    projectMap: Map<string, { id: string; name: string; identifier: string | null }>;
  }> {
    const validWorkItemIds = workItemIds.filter((id) => isUUID(id));
    const validPaperIds = paperIds.filter((id) => isUUID(id));
    const validPageIds = pageIds.filter((id) => isUUID(id));
    const validFileIds = fileIds.filter((id) => isUUID(id));
    const validProjectIds = projectIds.filter((id) => isUUID(id));

    const [workItems, papers, pages, files, projects] = await Promise.all([
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
        ? this.prisma.manuscriptDoc.findMany({
            where: { id: { in: validPageIds }, deleted: false },
            select: { id: true, path: true },
          })
        : [],
      validFileIds.length
        ? this.prisma.file.findMany({
            where: { id: { in: validFileIds }, trashedAt: null },
            select: { id: true, filename: true },
          })
        : [],
      validProjectIds.length
        ? this.prisma.project.findMany({
            where: { id: { in: validProjectIds } },
            select: { id: true, name: true, identifier: true },
          })
        : [],
    ]);

    const titleMap = new Map<string, string>();
    workItems.forEach((t) => {
      titleMap.set(`work_item:${t.id}`, t.title);
    });
    papers.forEach((p) => titleMap.set(`paper:${p.id}`, p.title));
    pages.forEach((pg) => titleMap.set(`page:${pg.id}`, pg.path || 'Manuscript'));
    files.forEach((f) => titleMap.set(`file:${f.id}`, f.filename));
    projects.forEach((prj) => titleMap.set(`project:${prj.id}`, prj.name));

    const projectMap = new Map<string, { id: string; name: string; identifier: string | null }>();
    projects.forEach((prj) => projectMap.set(prj.id, prj));

    return { titleMap, projectMap };
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
    return comments.map((c) => ({
      ...c,
      author: c.author
        ? {
            id: c.author.id,
            email: c.author.email,
            name: c.author.profile?.name ?? 'User',
            avatar: c.author.profile?.avatar ?? null,
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
