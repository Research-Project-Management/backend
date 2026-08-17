import { Injectable, Logger } from '@nestjs/common';
import { ActivityRepository } from './activity.repository';
import { DomainActivityEvent } from './events/activity.events';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType } from '@prisma/client';
import { RecentItemResponse } from './dto/activity.dto';

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly activityRepo: ActivityRepository,
    private readonly prisma: PrismaService,
  ) {}

  async recordEvent(event: DomainActivityEvent) {
    try {
      return await this.activityRepo.create(event);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to record activity event: ${message}`);
      return null;
    }
  }

  async getActivityFeed(
    workspaceId: string,
    options?: {
      projectId?: string;
      entityType?: EntityType;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
    const offset = (page - 1) * limit;

    const { items, total } = await this.activityRepo.findWorkspaceFeed(
      workspaceId,
      {
        projectId: options?.projectId,
        entityType: options?.entityType,
        limit,
        offset,
      },
    );

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Entity Timeline for TaskActivities modal (Plane.so style).
   */
  async getEntityActivity(entityType: EntityType, entityId: string, limit = 50) {
    const items = await this.activityRepo.findEntityFeed(entityType, entityId, limit);
    return {
      activities: items.map((item) => ({
        id: item.id,
        _id: item.id,
        entityType: item.entityType,
        entityId: item.entityId,
        verb: item.verb,
        action: item.verb,
        field: item.field,
        oldValue: item.oldValue,
        newValue: item.newValue,
        actorId: item.actorId,
        author: item.actor
          ? {
              id: item.actor.id,
              _id: item.actor.id,
              name: item.actor.name,
              email: item.actor.email,
              avatar: item.actor.avatar,
            }
          : undefined,
        user: item.actor
          ? {
              id: item.actor.id,
              _id: item.actor.id,
              name: item.actor.name,
              email: item.actor.email,
              avatar: item.actor.avatar,
            }
          : undefined,
        createdAt: item.createdAt,
      })),
    };
  }

  async getTaskActivity(taskId: string, limit = 50) {
    return this.getEntityActivity(EntityType.task, taskId, limit);
  }

  /**
   * Deep Seam: Get recently interacted items with Zero N+1 Queries.
   */
  async getRecentItems(
    workspaceId: string,
    userId: string,
    limit: number = 10,
  ): Promise<RecentItemResponse[]> {
    const recentEvents = await this.activityRepo.findRecentByActor(
      workspaceId,
      userId,
      50,
    );

    const seen = new Set<string>();
    const uniqueTargets: Array<{
      entityType: EntityType;
      entityId: string;
      lastInteractedAt: Date;
      projectId?: string | null;
    }> = [];

    for (const evt of recentEvents) {
      const key = `${evt.entityType}:${evt.entityId}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueTargets.push({
          entityType: evt.entityType,
          entityId: evt.entityId,
          lastInteractedAt: evt.createdAt,
          projectId: evt.projectId,
        });
        if (uniqueTargets.length >= limit) break;
      }
    }

    if (uniqueTargets.length === 0) {
      return this.fetchFallbackRecent(workspaceId, userId, limit);
    }

    const taskIds = uniqueTargets
      .filter((t) => t.entityType === 'task')
      .map((t) => t.entityId);
    const paperIds = uniqueTargets
      .filter((t) => t.entityType === 'paper')
      .map((t) => t.entityId);
    const pageIds = uniqueTargets
      .filter((t) => t.entityType === 'page')
      .map((t) => t.entityId);

    const [tasks, papers, pages] = await Promise.all([
      taskIds.length
        ? this.prisma.task.findMany({
            where: { id: { in: taskIds } },
            select: { id: true, title: true },
          })
        : [],
      paperIds.length
        ? this.prisma.paper.findMany({
            where: { id: { in: paperIds } },
            select: { id: true, title: true },
          })
        : [],
      pageIds.length
        ? this.prisma.page.findMany({
            where: { id: { in: pageIds } },
            select: { id: true, title: true },
          })
        : [],
    ]);

    const titleMap = new Map<string, string>();
    tasks.forEach((t) => titleMap.set(`task:${t.id}`, t.title));
    papers.forEach((p) => titleMap.set(`paper:${p.id}`, p.title));
    pages.forEach((pg) => titleMap.set(`page:${pg.id}`, pg.title));

    return uniqueTargets.map((target) => ({
      id: `${target.entityType}-${target.entityId}`,
      entityType: target.entityType,
      entityId: target.entityId,
      title:
        titleMap.get(`${target.entityType}:${target.entityId}`) ||
        `Untitled ${target.entityType}`,
      workspaceId,
      projectId: target.projectId,
      lastInteractedAt: target.lastInteractedAt,
    }));
  }

  private async fetchFallbackRecent(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<RecentItemResponse[]> {
    const [tasks, papers, pages] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          project: { workspaceId },
          OR: [{ authorId: userId }, { assigneeId: userId }],
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, projectId: true, updatedAt: true },
      }),
      this.prisma.paper.findMany({
        where: { workspaceId, uploadedById: userId },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, updatedAt: true },
      }),
      this.prisma.page.findMany({
        where: {
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

    const combined: RecentItemResponse[] = [
      ...tasks.map((t) => ({
        id: `task-${t.id}`,
        entityType: 'task' as EntityType,
        entityId: t.id,
        title: t.title,
        workspaceId,
        projectId: t.projectId,
        lastInteractedAt: t.updatedAt,
      })),
      ...papers.map((p) => ({
        id: `paper-${p.id}`,
        entityType: 'paper' as EntityType,
        entityId: p.id,
        title: p.title,
        workspaceId,
        projectId: null,
        lastInteractedAt: p.updatedAt,
      })),
      ...pages.map((p) => ({
        id: `page-${p.id}`,
        entityType: 'page' as EntityType,
        entityId: p.id,
        title: p.title,
        workspaceId,
        projectId: p.projectId,
        lastInteractedAt: p.updatedAt,
      })),
    ];

    return combined
      .sort((a, b) => b.lastInteractedAt.getTime() - a.lastInteractedAt.getTime())
      .slice(0, limit);
  }
}
