import { Injectable, Logger, Optional } from '@nestjs/common';
import { ActivityRepository } from './activity.repository';
import { DomainActivityEvent } from './events/activity.events';
import { EntityType } from '@prisma/client';
import { RecentItemResponse } from './dto/activity.dto';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { ACTIVITY_REDIS_KEYS } from './constants/redis-keys.constant';

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly activityRepo: ActivityRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async recordEvent(event: DomainActivityEvent) {
    try {
      const record = await this.activityRepo.create(event);
      await this.invalidateFeedCache(event);
      return record;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to record activity event: ${message}`);
      return null;
    }
  }

  async invalidateFeedCache(event: DomainActivityEvent) {
    if (!this.cache) return;
    try {
      const deletions: Promise<any>[] = [
        this.cache.del(ACTIVITY_REDIS_KEYS.workspaceFeed(event.workspaceId)),
        this.cache.del(
          ACTIVITY_REDIS_KEYS.entityFeed(event.entityType, event.entityId),
        ),
      ];
      if (event.projectId) {
        deletions.push(
          this.cache.del(ACTIVITY_REDIS_KEYS.projectFeed(event.projectId)),
        );
      }
      if (event.actorId) {
        deletions.push(
          this.cache.del(ACTIVITY_REDIS_KEYS.userRecent(event.actorId)),
        );
      }
      await Promise.all(deletions);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate activity cache: ${message}`);
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
    const workspace = await this.activityRepo.resolveWorkspace(workspaceId);
    const resolvedWorkspaceId = workspace?.id || workspaceId;
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
    const offset = (page - 1) * limit;

    const isDefaultQuery = page === 1 && !options?.entityType;
    const cacheKey = options?.projectId
      ? ACTIVITY_REDIS_KEYS.projectFeed(options.projectId)
      : ACTIVITY_REDIS_KEYS.workspaceFeed(resolvedWorkspaceId);

    if (this.cache && isDefaultQuery) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    const { items, total } = await this.activityRepo.findWorkspaceFeed(
      resolvedWorkspaceId,
      {
        projectId: options?.projectId,
        entityType: options?.entityType,
        limit,
        offset,
      },
    );

    const result = {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    if (this.cache && isDefaultQuery) {
      await this.cache.set(cacheKey, result, 300); // 5m TTL
    }

    return result;
  }

  /**
   * Entity Timeline for TaskActivities modal (Plane.so style).
   */
  async getEntityActivity(
    entityType: EntityType,
    entityId: string,
    limit = 50,
  ) {
    const cacheKey = ACTIVITY_REDIS_KEYS.entityFeed(entityType, entityId);

    if (this.cache && limit === 50) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    const items = await this.activityRepo.findEntityFeed(
      entityType,
      entityId,
      limit,
    );

    const result = {
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

    if (this.cache && limit === 50) {
      await this.cache.set(cacheKey, result, 1800); // 30m TTL
    }

    return result;
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
    const workspace = await this.activityRepo.resolveWorkspace(workspaceId);
    const resolvedWorkspaceId = workspace?.id || workspaceId;
    const cacheKey = ACTIVITY_REDIS_KEYS.userRecent(userId);

    if (this.cache && limit === 10) {
      const cached = await this.cache.get<RecentItemResponse[]>(cacheKey);
      if (cached) return cached;
    }

    const recentEvents = await this.activityRepo.findRecentByActor(
      resolvedWorkspaceId,
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

    let items: RecentItemResponse[];

    if (uniqueTargets.length === 0) {
      items = await this.fetchFallbackRecent(
        resolvedWorkspaceId,
        userId,
        limit,
      );
    } else {
      const taskIds = uniqueTargets
        .filter((target) => target.entityType === 'task')
        .map((target) => target.entityId);
      const paperIds = uniqueTargets
        .filter((target) => target.entityType === 'paper')
        .map((target) => target.entityId);
      const pageIds = uniqueTargets
        .filter((target) => target.entityType === 'page')
        .map((target) => target.entityId);

      const titleMap = await this.activityRepo.findEntitiesTitleMap(
        taskIds,
        paperIds,
        pageIds,
      );

      items = uniqueTargets.map((target) => ({
        id: `${target.entityType}-${target.entityId}`,
        entityType: target.entityType,
        entityId: target.entityId,
        title:
          titleMap.get(`${target.entityType}:${target.entityId}`) ||
          `Untitled ${target.entityType}`,
        workspaceId: resolvedWorkspaceId,
        projectId: target.projectId,
        lastInteractedAt: target.lastInteractedAt,
      }));
    }

    if (this.cache && limit === 10) {
      await this.cache.set(cacheKey, items, 600); // 10m TTL
    }

    return items;
  }

  private async fetchFallbackRecent(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<RecentItemResponse[]> {
    const workspace = await this.activityRepo.resolveWorkspace(workspaceId);
    const resolvedWorkspaceId = workspace?.id || workspaceId;

    const { tasks, papers, pages } =
      await this.activityRepo.findFallbackRecentItems(
        resolvedWorkspaceId,
        userId,
        limit,
      );

    const combined: RecentItemResponse[] = [
      ...tasks.map((taskRecord) => ({
        id: `task-${taskRecord.id}`,
        entityType: 'task' as const,
        entityId: taskRecord.id,
        title: taskRecord.title,
        workspaceId: resolvedWorkspaceId,
        projectId: taskRecord.projectId,
        lastInteractedAt: taskRecord.updatedAt,
      })),
      ...papers.map((paperRecord) => ({
        id: `paper-${paperRecord.id}`,
        entityType: 'paper' as const,
        entityId: paperRecord.id,
        title: paperRecord.title,
        workspaceId: resolvedWorkspaceId,
        projectId: null,
        lastInteractedAt: paperRecord.updatedAt,
      })),
      ...pages.map((pageRecord) => ({
        id: `page-${pageRecord.id}`,
        entityType: 'page' as const,
        entityId: pageRecord.id,
        title: pageRecord.title,
        workspaceId: resolvedWorkspaceId,
        projectId: pageRecord.projectId,
        lastInteractedAt: pageRecord.updatedAt,
      })),
    ];

    return combined
      .sort(
        (a, b) => b.lastInteractedAt.getTime() - a.lastInteractedAt.getTime(),
      )
      .slice(0, limit);
  }
}
