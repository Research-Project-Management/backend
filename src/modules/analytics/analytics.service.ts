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
    const cacheKey = `flux:analytics:proj:${projectId}:insights`;

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
    const completedTasks = tasks.filter(
      (taskItem) => taskItem.completed,
    ).length;
    const inProgressTasks = tasks.filter(
      (taskItem) =>
        taskItem.columnId === 'doing' ||
        taskItem.columnId === 'in_progress' ||
        taskItem.columnId === 'review' ||
        taskItem.columnId === 'in_review',
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
    const cacheKey = `flux:analytics:ws:${workspaceId}:overview`;

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

    const assigned = tasks.filter((taskItem) => taskItem.assigneeId === userId);
    const created = tasks.filter((taskItem) => taskItem.authorId === userId);
    const subscribed = tasks.filter(
      (taskItem) =>
        taskItem.assigneeId !== userId &&
        taskItem.authorId !== userId &&
        (taskItem.comments?.length || 0) > 0,
    );

    const formattedActivities = (activityFeed.items as ActivityFeedItem[]).map(
      (activityEvent) => {
        const isYou = activityEvent.actorId === userId;
        return {
          id: activityEvent.id,
          type: `${activityEvent.entityType}_${activityEvent.verb}`,
          actorName: isYou ? 'You' : activityEvent.actor?.name || 'A member',
          actionVerb: activityEvent.verb,
          targetIdentifier: activityEvent.field || null,
          targetTitle: activityEvent.newValue || activityEvent.entityId,
          content: `${isYou ? 'You' : activityEvent.actor?.name || 'Member'} ${activityEvent.verb} ${activityEvent.entityType}`,
          time: activityEvent.createdAt.toISOString(),
          itemId: activityEvent.entityId,
          user: activityEvent.actor
            ? {
                name: activityEvent.actor.name || '',
                avatar: activityEvent.actor.avatar || null,
              }
            : undefined,
          project: activityEvent.projectId
            ? {
                id: activityEvent.projectId,
                name: activityEvent.project?.name || '',
              }
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
