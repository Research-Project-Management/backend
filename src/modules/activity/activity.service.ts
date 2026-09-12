import { Injectable, Logger, Optional, NotFoundException } from '@nestjs/common';
import { ActivityRepository } from './activity.repository';
import { DomainActivityEvent } from './events/activity.events';
import { EntityType } from '@prisma/client';
import { RecentItemResponse } from './dto/activity.dto';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { ACTIVITY_REDIS_KEYS } from './constants/redis-keys.constant';

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function resolveStateInfo(
  stateId: string | null | undefined,
  taskColumns: any,
): { id: string; name: string; color: string; group: string } {
  if (!stateId) {
    return { id: '', name: 'None', color: '#94a3b8', group: 'backlog' };
  }

  const columns = Array.isArray(taskColumns) ? taskColumns : [];
  const found = columns.find((c: any) => c.id === stateId || c.slug === stateId);
  if (found) {
    return {
      id: found.id || stateId,
      name: found.title || found.name || stateId,
      color: found.accentColor || found.color || '#3b82f6',
      group: found.group || 'unstarted',
    };
  }

  // Fallback defaults for standard slugs
  const lower = stateId.toLowerCase();
  if (lower.includes('backlog')) {
    return { id: stateId, name: 'Backlog', color: '#94a3b8', group: 'backlog' };
  }
  if (lower.includes('todo') || lower.includes('unstarted')) {
    return { id: stateId, name: 'To Do', color: '#64748b', group: 'unstarted' };
  }
  if (lower.includes('progress') || lower.includes('started')) {
    return { id: stateId, name: 'In Progress', color: '#3b82f6', group: 'started' };
  }
  if (lower.includes('done') || lower.includes('complete')) {
    return { id: stateId, name: 'Completed', color: '#10b981', group: 'completed' };
  }
  if (lower.includes('cancel')) {
    return { id: stateId, name: 'Cancelled', color: '#ef4444', group: 'cancelled' };
  }

  return { id: stateId, name: stateId, color: '#3b82f6', group: 'custom' };
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly activityRepo: ActivityRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async recordEvent(event: DomainActivityEvent) {
    try {
      if (!event.workspaceId && event.projectId) {
        const workspaceId = await this.activityRepo.findProjectWorkspaceId(
          event.projectId,
        );
        if (workspaceId) {
          event.workspaceId = workspaceId;
        }
      }
      if (!event.workspaceId) {
        this.logger.warn(
          `Skipping activity event without workspaceId: ${event.verb} on ${event.entityType}:${event.entityId}`,
        );
        return null;
      }
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
   * Entity Timeline for TaskActivities modal.
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
              name: item.actor.name,
              email: item.actor.email,
              avatar: item.actor.avatar,
            }
          : undefined,
        user: item.actor
          ? {
              id: item.actor.id,
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
   * Tracks full state transition flow and time-in-state calculation (Plane.so Transition tab).
   */
  async getTaskTransitions(taskId: string) {
    const task = await this.activityRepo.findTaskWithProject(taskId);
    if (!task) {
      throw new NotFoundException(`Work item '${taskId}' not found`);
    }

    const taskColumns = task.project?.taskColumns || [];

    // Find state transition events in chronological order
    const events = await this.activityRepo.findTaskActivityEvents(taskId, 'asc');
    const transitionEvents = events.filter(
      (e) =>
        e.field === 'state' ||
        e.field === 'columnId' ||
        e.verb === 'transitioned',
    );

    const transitions: Array<{
      id: string;
      fromState: { id: string; name: string; color: string; group: string };
      toState: { id: string; name: string; color: string; group: string };
      actor?: any;
      transitionedAt: Date;
      timeInStateMs: number;
      timeInStateFormatted: string;
    }> = [];

    let prevTimestamp = task.createdAt.getTime();
    let currentStateId = task.columnId;

    if (transitionEvents.length > 0) {
      for (const evt of transitionEvents) {
        const transitionTime = evt.createdAt.getTime();
        const durationMs = Math.max(0, transitionTime - prevTimestamp);

        const fromState = resolveStateInfo(evt.oldValue, taskColumns);
        const toState = resolveStateInfo(evt.newValue, taskColumns);

        transitions.push({
          id: evt.id,
          fromState,
          toState,
          actor: evt.actor,
          transitionedAt: evt.createdAt,
          timeInStateMs: durationMs,
          timeInStateFormatted: formatDuration(durationMs),
        });

        prevTimestamp = transitionTime;
        if (evt.newValue) {
          currentStateId = evt.newValue;
        }
      }
    }

    // Current state duration
    const now = Date.now();
    const currentDurationMs = Math.max(0, now - prevTimestamp);
    const currentState = resolveStateInfo(currentStateId, taskColumns);

    const totalCycleTimeMs = task.completed
      ? Math.max(0, task.updatedAt.getTime() - task.createdAt.getTime())
      : Math.max(0, now - task.createdAt.getTime());

    return {
      taskId,
      currentState,
      currentDurationMs,
      currentDurationFormatted: formatDuration(currentDurationMs),
      totalCycleTimeMs,
      totalCycleTimeFormatted: formatDuration(totalCycleTimeMs),
      completed: task.completed,
      transitions,
    };
  }

  /**
   * Tracks title and description revisions with oldValue and newValue diffs (Plane.so History tab).
   */
  async getTaskHistory(
    taskId: string,
    options?: { sort?: 'asc' | 'desc' },
  ) {
    const sort = options?.sort || 'desc';
    const events = await this.activityRepo.findTaskActivityEvents(taskId, sort);

    const historyEvents = events.filter(
      (e) =>
        e.field === 'title' ||
        e.field === 'description' ||
        e.field === 'content',
    );

    return {
      taskId,
      histories: historyEvents.map((evt) => ({
        id: evt.id,
        field: evt.field === 'content' ? 'description' : evt.field,
        oldValue: evt.oldValue,
        newValue: evt.newValue,
        actor: evt.actor,
        createdAt: evt.createdAt,
      })),
    };
  }

  /**
   * Unified Collaboration Feed supporting 5 tabs: all, activity, comments, transition, history.
   */
  async getWorkItemUnifiedFeed(
    taskId: string,
    options?: {
      tab?: string;
      sort?: 'asc' | 'desc';
      page?: number;
      limit?: number;
    },
  ) {
    const tab = (options?.tab || 'all').toLowerCase();
    const sort = options?.sort === 'desc' ? 'desc' : 'asc';
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 50));

    if (tab === 'transition' || tab === 'transitions') {
      const data = await this.getTaskTransitions(taskId);
      return { tab: 'transition', ...data };
    }

    if (tab === 'history') {
      const data = await this.getTaskHistory(taskId, { sort });
      return { tab: 'history', ...data };
    }

    if (tab === 'comments') {
      const comments = await this.activityRepo.findTaskComments(taskId, sort);
      const feed = comments.map((c) => ({
        id: c.id,
        type: 'comment' as const,
        timestamp: c.createdAt,
        actor: c.author,
        comment: {
          id: c.id,
          content: c.content,
          isEdited: c.isEdited,
          reactions: c.reactions,
          replies: c.replies,
          attachments: c.attachments || [],
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
      }));
      return {
        tab: 'comments',
        total: feed.length,
        feed: feed.slice((page - 1) * limit, page * limit),
        comments,
      };
    }

    if (tab === 'activity') {
      const activities = await this.activityRepo.findTaskActivityEvents(
        taskId,
        sort,
      );
      const propActivities = activities.filter((e) => e.field !== 'comment');
      const feed = propActivities.map((a) => ({
        id: a.id,
        type: 'activity' as const,
        timestamp: a.createdAt,
        actor: a.actor,
        activity: {
          id: a.id,
          verb: a.verb,
          field: a.field,
          oldValue: a.oldValue,
          newValue: a.newValue,
          createdAt: a.createdAt,
        },
      }));
      return {
        tab: 'activity',
        total: feed.length,
        feed: feed.slice((page - 1) * limit, page * limit),
        activities: propActivities,
      };
    }

    // Default: Tab 'all' - Unified stream of comments, activities, transitions, and history
    const [comments, activities, task] = await Promise.all([
      this.activityRepo.findTaskComments(taskId, 'asc'),
      this.activityRepo.findTaskActivityEvents(taskId, 'asc'),
      this.activityRepo.findTaskWithProject(taskId),
    ]);

    const taskColumns = task?.project?.taskColumns || [];

    const unifiedItems: Array<{
      id: string;
      type: 'comment' | 'activity' | 'transition' | 'history';
      timestamp: Date;
      actor: any;
      comment?: any;
      activity?: any;
      transition?: any;
      history?: any;
    }> = [];

    for (const c of comments) {
      unifiedItems.push({
        id: c.id,
        type: 'comment',
        timestamp: c.createdAt,
        actor: c.author,
        comment: {
          id: c.id,
          content: c.content,
          isEdited: c.isEdited,
          reactions: c.reactions,
          replies: c.replies,
          attachments: c.attachments || [],
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        },
      });
    }

    for (const a of activities) {
      if (
        a.field === 'state' ||
        a.field === 'columnId' ||
        a.verb === 'transitioned'
      ) {
        unifiedItems.push({
          id: a.id,
          type: 'transition',
          timestamp: a.createdAt,
          actor: a.actor,
          transition: {
            id: a.id,
            fromState: resolveStateInfo(a.oldValue, taskColumns),
            toState: resolveStateInfo(a.newValue, taskColumns),
            transitionedAt: a.createdAt,
          },
        });
      } else if (
        a.field === 'title' ||
        a.field === 'description' ||
        a.field === 'content'
      ) {
        unifiedItems.push({
          id: a.id,
          type: 'history',
          timestamp: a.createdAt,
          actor: a.actor,
          history: {
            id: a.id,
            field: a.field === 'content' ? 'description' : a.field,
            oldValue: a.oldValue,
            newValue: a.newValue,
            createdAt: a.createdAt,
          },
        });
      } else {
        unifiedItems.push({
          id: a.id,
          type: 'activity',
          timestamp: a.createdAt,
          actor: a.actor,
          activity: {
            id: a.id,
            verb: a.verb,
            field: a.field,
            oldValue: a.oldValue,
            newValue: a.newValue,
            createdAt: a.createdAt,
          },
        });
      }
    }

    unifiedItems.sort((a, b) => {
      const diff = a.timestamp.getTime() - b.timestamp.getTime();
      return sort === 'desc' ? -diff : diff;
    });

    const offset = (page - 1) * limit;
    const pagedFeed = unifiedItems.slice(offset, offset + limit);

    return {
      tab: 'all',
      total: unifiedItems.length,
      feed: pagedFeed,
      activities: activities.map((item) => ({
        id: item.id,
        entityType: item.entityType,
        entityId: item.entityId,
        verb: item.verb,
        field: item.field,
        oldValue: item.oldValue,
        newValue: item.newValue,
        actor: item.actor,
        createdAt: item.createdAt,
      })),
      comments,
    };
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
