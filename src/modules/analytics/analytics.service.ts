import { Injectable } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { ActivityService } from '../activity/activity.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import {
  ProjectTaskDistributionDto,
  CycleAnalyticsDto,
  YourWorkSummaryDto,
  WorkspaceStatsResponse,
} from './dto/analytics.dto';

interface ActivityFeedItem {
  id: string;
  entityType: string;
  verb: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  actorId: string;
  projectId?: string | null;
  createdAt: Date;
  entityId: string;
  actor?: {
    name?: string | null;
    avatar?: string | null;
  } | null;
  project?: {
    id: string;
    name: string;
  } | null;
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly analyticsRepo: AnalyticsRepository,
    private readonly activityService: ActivityService,
    private readonly cache: RedisCacheService,
  ) {}

  /**
   * Project Dimensional Analytics (Plane.so style: by State, Priority, Assignee)
   */
  async getProjectAnalytics(
    projectId: string,
  ): Promise<ProjectTaskDistributionDto> {
    const cacheKey = `analytics:project:${projectId}:insights`;

    return this.cache.wrap(
      cacheKey,
      async () => {
        const tasks =
          await this.analyticsRepo.findProjectTasksWithAssignees(projectId);

        const state: Record<string, number> = {};
        const priority: Record<string, number> = {};
        const assigneeMap = new Map<
          string,
          { userId: string; name: string; avatar: string | null; count: number }
        >();

        for (const task of tasks) {
          // State / Column distribution
          const column = task.columnId || 'unassigned';
          state[column] = (state[column] || 0) + 1;

          // Priority distribution
          const prio = task.priority || 'none';
          priority[prio] = (priority[prio] || 0) + 1;

          // Assignee distribution
          if (task.assigneeId && task.assignee) {
            const existing = assigneeMap.get(task.assigneeId) || {
              userId: task.assigneeId,
              name: task.assignee.name || 'Anonymous',
              avatar: task.assignee.avatar,
              count: 0,
            };
            existing.count += 1;
            assigneeMap.set(task.assigneeId, existing);
          }
        }

        return {
          state,
          priority,
          assignee: Array.from(assigneeMap.values()),
        };
      },
      300, // 5 min TTL
    );
  }

  /**
   * Cycle / Sprint Analytics (Plane.so style: Burndown rate & progress)
   */
  async getCycleAnalytics(cycleId: string): Promise<CycleAnalyticsDto> {
    const tasks = await this.analyticsRepo.findCycleTasks(cycleId);
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.completed).length;
    const inProgressTasks = tasks.filter(
      (t) =>
        t.columnId === 'doing' ||
        t.columnId === 'in_progress' ||
        t.columnId === 'review' ||
        t.columnId === 'in_review',
    ).length;
    const pendingTasks = totalTasks - completedTasks - inProgressTasks;
    const completionRate =
      totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return {
      cycleId,
      totalTasks,
      completedTasks,
      inProgressTasks,
      pendingTasks,
      completionRate,
    };
  }

  /**
   * Workspace Aggregation Overview
   */
  async getWorkspaceOverview(
    workspaceId: string,
  ): Promise<{ stats: WorkspaceStatsResponse }> {
    const cacheKey = `analytics:workspace:${workspaceId}:overview`;

    return this.cache.wrap(
      cacheKey,
      async () => {
        const stats = await this.analyticsRepo.countWorkspaceStats(workspaceId);
        return { stats };
      },
      300,
    );
  }

  /**
   * Your Workload & Activity Aggregator
   */
  async getYourWork(
    workspaceId: string,
    userId: string,
  ): Promise<YourWorkSummaryDto> {
    const [tasks, activityFeed, recentItems] = await Promise.all([
      this.analyticsRepo.findUserWorkspaceTasks(workspaceId, userId),
      this.activityService.getActivityFeed(workspaceId, { limit: 20 }),
      this.activityService.getRecentItems(workspaceId, userId, 10),
    ]);

    const assigned = tasks.filter((t) => t.assigneeId === userId);
    const created = tasks.filter((t) => t.authorId === userId);
    const subscribed = tasks.filter(
      (t) =>
        t.assigneeId !== userId &&
        t.authorId !== userId &&
        (t.comments?.length || 0) > 0,
    );

    const formattedActivities = (activityFeed.items as ActivityFeedItem[]).map(
      (evt) => {
        const isYou = evt.actorId === userId;
        return {
          id: evt.id,
          type: `${evt.entityType}_${evt.verb}`,
          actorName: isYou ? 'You' : evt.actor?.name || 'A member',
          actionVerb: evt.verb,
          targetIdentifier: evt.field || null,
          targetTitle: evt.newValue || evt.entityId,
          content: `${isYou ? 'You' : evt.actor?.name || 'Member'} ${evt.verb} ${evt.entityType}`,
          time: evt.createdAt.toISOString(),
          itemId: evt.entityId,
          user: evt.actor
            ? { name: evt.actor.name || '', avatar: evt.actor.avatar || null }
            : undefined,
          project: evt.projectId
            ? { id: evt.projectId, name: evt.project?.name || '' }
            : undefined,
        };
      },
    );

    return {
      workspaceId,
      userId,
      assigned,
      created,
      subscribed,
      activity: formattedActivities,
      recent: recentItems,
      success: true,
    };
  }
}
