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
import { ActivityFeedItem } from './types/analytics.types';
import {
  aggregateProjectDistributions,
  calculateCycleMetrics,
} from './utils/analytics.utils';

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
        return aggregateProjectDistributions(tasks);
      },
      300, // 5 min TTL
    );
  }

  /**
   * Cycle / Sprint Analytics (Plane.so style: Burndown rate & progress)
   */
  async getCycleAnalytics(cycleId: string): Promise<CycleAnalyticsDto> {
    const tasks = await this.analyticsRepo.findCycleTasks(cycleId);
    return calculateCycleMetrics(cycleId, tasks);
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
