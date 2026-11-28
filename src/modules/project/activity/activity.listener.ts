import { Injectable, Logger } from '@nestjs/common';
import { PROJECT_REDIS_KEYS } from '@/modules/project/core/constants/cache.constant';
import { OnEvent } from '@nestjs/event-emitter';
import { ActivityService } from './activity.service';
import { DomainActivityEvent } from './events/activity.events';
import { RedisCacheService } from '@/core';

export interface WorkItemEventPayload {
  entityId?: string;
  workItemId?: string;
  verb?: string;
  actorId?: string;
  authorId?: string;
  projectId?: string;
  field?: string;
  oldValue?: string;
  newValue?: string;
  columnId?: string;
  [key: string]: unknown;
}

export interface CommentEventPayload extends WorkItemEventPayload {
  commentId?: string;
  content?: string;
}

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

    if (event.actorId && event.entityId) {
      await this.activityService.recordEvent(event);
    }
    await this.invalidateAnalyticsCache(event.projectId, event.actorId);
  }

  @OnEvent('work-item.*', { async: true })
  async handleWorkItemEvents(
    event: WorkItemEventPayload | DomainActivityEvent,
  ) {
    if (event instanceof DomainActivityEvent) {
      return this.handleGenericActivity(event);
    }
    if (event?.entityType === 'project') {
      await this.invalidateAnalyticsCache(
        event.projectId,
        event.actorId || event.authorId,
      );
      return;
    }
    const entityId = event?.entityId || event?.workItemId;
    if (entityId) {
      const activityEvent = new DomainActivityEvent({
        entityType: 'work_item',
        entityId,
        verb: event.verb || 'updated',
        actorId: event.actorId || event.authorId || '',
        projectId: event.projectId,
        field: event.field,
        oldValue:
          event.oldValue !== undefined ? String(event.oldValue) : undefined,
        newValue:
          event.newValue !== undefined ? String(event.newValue) : undefined,
      });
      await this.handleGenericActivity(activityEvent);

      // Record initial state if WorkItem was created with a column
      if (event.verb === 'created' && event.columnId) {
        const stateInitEvent = new DomainActivityEvent({
          entityType: 'work_item',
          entityId,
          verb: 'transitioned',
          actorId: event.actorId || event.authorId || '',
          projectId: event.projectId,
          field: 'state',
          oldValue: undefined,
          newValue: event.columnId,
        });
        await this.handleGenericActivity(stateInitEvent);
      }
    }
  }

  @OnEvent('comment.*', { async: true })
  async handleCommentEvents(event: CommentEventPayload) {
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
  async handleStateEvents(event: DomainActivityEvent | WorkItemEventPayload) {
    if (event instanceof DomainActivityEvent) {
      return this.handleGenericActivity(event);
    }
    const entityId = event?.entityId || event?.projectId;
    if (entityId) {
      const activityEvent = new DomainActivityEvent({
        entityType: 'project',
        entityId,
        verb: event.verb || 'updated',
        actorId: event.actorId || '',
        projectId: event.projectId,
      });
      await this.handleGenericActivity(activityEvent);
    }
  }

  @OnEvent('pages.*', { async: true })
  async handlePagesRealtimeEvents(payload: {
    spaceId?: string;
    projectId?: string;
    event?: string;
    eventName?: string;
    payload?: Record<string, unknown>;
    data?: Record<string, unknown>;
    docId?: string;
    actorId?: string;
  }) {
    const rawSpaceId = payload?.spaceId || payload?.projectId;
    if (!rawSpaceId) return;

    const eventName = payload.event || payload.eventName || '';
    const data = payload.payload || payload.data || {};
    const actorId = (data.userId ||
      data.actorId ||
      payload.actorId ||
      '') as string;
    const docId = (data.docId || payload.docId || '') as string;

    let verb = 'updated';
    let entityType: any = 'page';

    if (eventName.includes('comment')) {
      entityType = 'comment';
      verb = eventName.includes('create')
        ? 'commented'
        : eventName.includes('resolve')
          ? 'resolved'
          : 'updated_comment';
    } else if (eventName.includes('track-changes')) {
      verb = eventName.includes('resolve')
        ? 'resolved_suggestion'
        : 'suggested_change';
    } else if (eventName.includes('version') || eventName.includes('restore')) {
      verb = 'restored_version';
    } else if (eventName.includes('file-tree')) {
      verb = 'file_tree_updated';
    }

    const projectId =
      actorId && rawSpaceId === actorId ? undefined : rawSpaceId;

    const activityEvent = new DomainActivityEvent({
      entityType,
      entityId: docId || rawSpaceId,
      verb,
      actorId,
      spaceId: rawSpaceId,
      projectId,
      field: eventName || 'manuscript',
      newValue:
        typeof data.text === 'string' ? data.text.slice(0, 100) : undefined,
    });

    await this.handleGenericActivity(activityEvent);
  }

  private async invalidateAnalyticsCache(
    projectId?: string | null,
    userId?: string | null,
  ) {
    try {
      if (projectId) {
        await this.redisCache.del(
          PROJECT_REDIS_KEYS.analyticsProjectInsights(projectId),
        );
        await this.redisCache.del(
          PROJECT_REDIS_KEYS.analyticsProjectOverview(projectId),
        );
        await this.redisCache.delPattern(
          PROJECT_REDIS_KEYS.analyticsProjectPattern(projectId),
        );
      }
      if (userId) {
        await this.redisCache.del(
          PROJECT_REDIS_KEYS.analyticsUserOverview(userId),
        );
        await this.redisCache.delPattern(
          PROJECT_REDIS_KEYS.analyticsUserPattern(userId),
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to invalidate analytics cache: ${message}`);
    }
  }
}
