import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { DomainActivityEvent } from './events/activity.events';
import { EntityType, ActivityEvent } from '@prisma/client';
import {
  IActivityRepository,
  ActivityEventWithActor,
  ACTOR_MINIMAL_SELECT,
} from './types/activity-repository.interface';

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
        workspaceId: event.workspaceId,
        projectId: event.projectId,
      },
    });
  }

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [
          { id: workspaceIdOrSlug },
          { slug: workspaceIdOrSlug },
          { url: workspaceIdOrSlug },
        ],
        deletedAt: null,
      },
      select: { id: true },
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
  ): Promise<{ items: ActivityEventWithActor[]; total: number }> {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const where: any = { workspaceId: targetWsId };
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
          actor: { select: ACTOR_MINIMAL_SELECT },
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.activityEvent.count({ where }),
    ]);

    return { items, total };
  }

  async findEntityFeed(
    entityType: EntityType,
    entityId: string,
    limit = 50,
  ): Promise<ActivityEventWithActor[]> {
    return this.prisma.activityEvent.findMany({
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
  }

  async findRecentByActor(
    workspaceId: string,
    actorId: string,
    limit = 50,
  ): Promise<ActivityEvent[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;
    return this.prisma.activityEvent.findMany({
      where: {
        workspaceId: targetWsId,
        actorId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Batch-resolve titles for recent entities (task / paper / page).
   * Returns a Map<"type:id", title>.
   */
  async findEntitiesTitleMap(
    taskIds: string[],
    paperIds: string[],
    pageIds: string[],
  ): Promise<Map<string, string>> {
    const [tasks, papers, pages] = await Promise.all([
      taskIds.length
        ? this.prisma.task.findMany({
            where: { id: { in: taskIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
      paperIds.length
        ? this.prisma.catalogItem.findMany({
            where: { id: { in: paperIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
      pageIds.length
        ? this.prisma.page.findMany({
            where: { id: { in: pageIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
    ]);

    const map = new Map<string, string>();
    tasks.forEach((t) => map.set(`task:${t.id}`, t.title));
    papers.forEach((p) => map.set(`paper:${p.id}`, p.title));
    pages.forEach((pg) => map.set(`page:${pg.id}`, pg.title));
    return map;
  }

  /**
   * Fallback: get recently updated items owned by user across all entity types.
   */
  async findFallbackRecentItems(
    workspaceId: string,
    userId: string,
    limit: number,
  ) {
    const [tasks, papers, pages] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          project: { workspaceId },
          deletedAt: null,
          OR: [{ authorId: userId }, { assigneeId: userId }],
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, projectId: true, updatedAt: true },
      }),
      this.prisma.catalogItem.findMany({
        where: { workspaceId, uploadedById: userId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, updatedAt: true },
      }),
      this.prisma.page.findMany({
        where: {
          deletedAt: null,
          OR: [
            { workspaceId, authorId: userId },
            { project: { workspaceId }, authorId: userId },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, projectId: true, updatedAt: true },
      }),
    ]);
    return { tasks, papers, pages };
  }
}
