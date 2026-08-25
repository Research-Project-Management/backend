import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityService } from './activity.service';
import { DomainActivityEvent } from './events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

@Injectable()
export class ActivityListener {
  private readonly logger = new Logger(ActivityListener.name);

  constructor(
    private readonly activityService: ActivityService,
    private readonly redisCache: RedisCacheService,
  ) {}

  @OnEvent('activity.event', { async: true })
  async handleGenericActivity(event: DomainActivityEvent) {
    this.logger.debug(
      `Received activity event: ${event.verb} on ${event.entityType}:${event.entityId}`,
    );

    await this.activityService.recordEvent(event);
    await this.invalidateAnalyticsCache(event.workspaceId, event.projectId);
  }

  @OnEvent('task.*', { async: true })
  async handleTaskEvents(event: DomainActivityEvent) {
    if (event?.entityType) {
      await this.handleGenericActivity(event);
    }
  }

  @OnEvent('paper.*', { async: true })
  async handlePaperEvents(event: DomainActivityEvent) {
    if (event?.entityType) {
      await this.handleGenericActivity(event);
    }
  }

  @OnEvent('page.*', { async: true })
  async handlePageEvents(event: DomainActivityEvent) {
    if (event?.entityType) {
      await this.handleGenericActivity(event);
    }
  }

  @OnEvent('project.*', { async: true })
  async handleProjectEvents(event: DomainActivityEvent) {
    if (event?.entityType) {
      await this.handleGenericActivity(event);
    }
  }

  @OnEvent('cycle.*', { async: true })
  async handleCycleEvents(event: DomainActivityEvent) {
    if (event?.entityType) {
      await this.handleGenericActivity(event);
    }
  }

  private async invalidateAnalyticsCache(
    workspaceId: string,
    projectId?: string | null,
  ) {
    try {
      if (workspaceId) {
        await this.redisCache.del(
          `analytics:workspace:${workspaceId}:overview`,
        );
        await this.redisCache.delPattern(
          `analytics:workspace:${workspaceId}:*`,
        );
      }
      if (projectId) {
        await this.redisCache.del(`analytics:project:${projectId}:insights`);
        await this.redisCache.delPattern(`analytics:project:${projectId}:*`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate analytics cache: ${message}`);
    }
  }
}
