import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityService } from './activity.service';
import { DomainActivityEvent } from './events/activity.events';
import { RedisCacheService } from '@/core/cache/redis.service';

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
    await this.invalidateAnalyticsCache(event.projectId, event.actorId);
  }

  @OnEvent('work-item.*', { async: true })
  async handleWorkItemEvents(event: any) {
    if (event instanceof DomainActivityEvent) {
      return this.handleGenericActivity(event);
    }
    const entityId = event?.entityId || event?.workItemId;
    if (entityId) {
      const activityEvent = new DomainActivityEvent({
        entityType: 'work_item' as any,
        entityId,
        verb: event.verb || 'updated',
        actorId: event.actorId || event.authorId || '',
        projectId: event.projectId,
        field: event.field,
        oldValue: event.oldValue,
        newValue: event.newValue,
      });
      await this.handleGenericActivity(activityEvent);

      // Record initial state if WorkItem was created with a column
      if (event.verb === 'created' && event.columnId) {
        const stateInitEvent = new DomainActivityEvent({
          entityType: 'work_item' as any,
          entityId,
          verb: 'transitioned',
          actorId: event.actorId || event.authorId || '',
          projectId: event.projectId,
          field: 'state',
          oldValue: null as any,
          newValue: event.columnId,
        });
        await this.handleGenericActivity(stateInitEvent);
      }
    }
  }

  @OnEvent('comment.*', { async: true })
  async handleCommentEvents(event: any) {
    const targetId = event.workItemId;
    if (!targetId) return;

    const activityEvent = new DomainActivityEvent({
      entityType: 'comment',
      entityId: event.commentId || targetId,
      verb: event.content !== undefined ? 'commented' : 'updated_comment',
      actorId: event.authorId || '',
      projectId: event.projectId,
      field: 'comment',
      newValue:
        typeof event.content === 'string'
          ? event.content.slice(0, 100)
          : undefined,
    });
    await this.handleGenericActivity(activityEvent);
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

  @OnEvent('state.*', { async: true })
  async handleStateEvents(event: any) {
    if (event instanceof DomainActivityEvent) {
      return this.handleGenericActivity(event);
    }
    const entityId = event?.entityId || event?.projectId;
    if (entityId) {
      const activityEvent = new DomainActivityEvent({
        entityType: 'project' as any,
        entityId,
        verb: event.verb || 'updated',
        actorId: event.actorId || '',
        projectId: event.projectId,
      });
      await this.handleGenericActivity(activityEvent);
    }
  }

  @OnEvent('cycle.*', { async: true })
  async handleCycleEvents(event: any) {
    if (event instanceof DomainActivityEvent) {
      return this.handleGenericActivity(event);
    }
    const entityId = event?.entityId || event?.cycleId;
    if (entityId) {
      const activityEvent = new DomainActivityEvent({
        entityType: 'cycle',
        entityId,
        verb: event.verb || 'updated',
        actorId: event.actorId || event.userId || '',
        projectId: event.projectId,
        field: event.field,
        oldValue: event.oldValue,
        newValue: event.newValue,
      });
      await this.handleGenericActivity(activityEvent);
    }
  }

  private async invalidateAnalyticsCache(
    projectId?: string | null,
    userId?: string | null,
  ) {
    try {
      if (projectId) {
        await this.redisCache.del(`analytics:project:${projectId}:insights`);
        await this.redisCache.delPattern(`analytics:project:${projectId}:*`);
      }
      if (userId) {
        await this.redisCache.del(`analytics:user:${userId}:overview`);
        await this.redisCache.delPattern(`analytics:user:${userId}:*`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate analytics cache: ${message}`);
    }
  }
}
