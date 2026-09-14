import { Injectable } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { RedisCacheService } from '@/core/cache/redis.service';
import {
  ProjectWorkItemDistributionDto,
  CycleAnalyticsDto,
  ProjectOverviewDto,
  UserOverviewDto,
} from './dto/analytics.dto';
import {
  aggregateProjectDistributions,
  calculateCycleMetrics,
} from './utils/analytics.utils';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly analyticsRepo: AnalyticsRepository,
    private readonly cache: RedisCacheService,
  ) {}

  /**
   * Project Dimensional Analytics (by State, Priority, Assignee)
   */
  async getProjectAnalytics(
    projectId: string,
  ): Promise<ProjectWorkItemDistributionDto> {
    const cacheKey = `flux:analytics:proj:${projectId}:insights`;

    return this.cache.wrap(
      cacheKey,
      async () => {
        const items = await this.analyticsRepo.findProjectWorkItemsWithAssignees(projectId);
        return aggregateProjectDistributions(items);
      },
      300, // 5 min TTL
    );
  }

  /**
   * Cycle / Sprint Analytics (Burndown rate & progress)
   */
  async getCycleAnalytics(cycleId: string): Promise<CycleAnalyticsDto> {
    const items = await this.analyticsRepo.findCycleWorkItems(cycleId);
    return calculateCycleMetrics(cycleId, items);
  }

  /**
   * Project Dimensional Overview (members, workItems, pages, files, stickies, cycles)
   */
  async getProjectOverview(
    projectId: string,
  ): Promise<{ stats: ProjectOverviewDto }> {
    const cacheKey = `flux:analytics:proj:${projectId}:overview`;

    return this.cache.wrap(
      cacheKey,
      async () => {
        const stats = await this.analyticsRepo.countProjectStats(projectId);
        return { stats };
      },
      300,
    );
  }

  /**
   * User Personal Aggregation Overview
   */
  async getUserOverview(
    userId: string,
  ): Promise<{ stats: UserOverviewDto }> {
    const cacheKey = `flux:analytics:user:${userId}:overview`;

    return this.cache.wrap(
      cacheKey,
      async () => {
        const stats = await this.analyticsRepo.countUserStats(userId);
        return { stats };
      },
      300,
    );
  }

  /** Label distribution: { label, count }[] for a project */
  async getLabelDistribution(
    projectId: string,
  ): Promise<{ labels: { label: string; count: number }[] }> {
    const items = await this.analyticsRepo.findProjectWorkItemsByLabel(projectId);
    const labelCount: Record<string, number> = {};
    for (const item of items) {
      const labels: string[] = Array.isArray(item.labels) ? item.labels : [];
      for (const label of labels) {
        if (label) labelCount[label] = (labelCount[label] || 0) + 1;
      }
    }
    const labels = Object.entries(labelCount)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    return { labels };
  }

  /**
   * Time-series: work items created and completed per day.
   * @param from  ISO date string (inclusive)
   * @param to    ISO date string (inclusive)
   */
  async getTimeSeries(
    projectId: string,
    from: string,
    to: string,
  ): Promise<{
    series: { date: string; created: number; completed: number }[];
  }> {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const items = await this.analyticsRepo.findProjectWorkItemsTimeSeries(
      projectId,
      fromDate,
      toDate,
    );

    const dateMap: Record<string, { created: number; completed: number }> = {};
    const cursor = new Date(fromDate);
    while (cursor <= toDate) {
      dateMap[cursor.toISOString().slice(0, 10)] = { created: 0, completed: 0 };
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const item of items) {
      const createdKey = item.createdAt.toISOString().slice(0, 10);
      if (dateMap[createdKey]) dateMap[createdKey].created += 1;
      if (item.completed) {
        const completedKey = item.updatedAt.toISOString().slice(0, 10);
        if (dateMap[completedKey]) dateMap[completedKey].completed += 1;
      }
    }

    const series = Object.entries(dateMap).map(([date, v]) => ({ date, ...v }));
    return { series };
  }

  /** Burn-down chart: remaining work items per day from cycle start to today/end */
  async getCycleBurndown(cycleId: string): Promise<{
    cycleId: string;
    burndown: { date: string; remaining: number; completed: number }[];
  }> {
    const cycle = await this.analyticsRepo.findCycleById(cycleId);
    const items = await this.analyticsRepo.findCycleWorkItemsWithDates(cycleId);

    const total = items.length;
    const startDate = cycle?.startDate ? new Date(cycle.startDate) : new Date();
    const endDate = cycle?.endDate ? new Date(cycle.endDate) : new Date();
    const today = new Date();
    const chartEnd = endDate < today ? endDate : today;

    const burndown: { date: string; remaining: number; completed: number }[] =
      [];
    const cursor = new Date(startDate);

    while (cursor <= chartEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const completedByDay = items.filter(
        (t) =>
          t.completed &&
          new Date(t.updatedAt) <= new Date(dateStr + 'T23:59:59Z'),
      ).length;
      burndown.push({
        date: dateStr,
        remaining: total - completedByDay,
        completed: completedByDay,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    return { cycleId, burndown };
  }

  /** Velocity: work items completed vs total in a cycle */
  async getCycleVelocity(cycleId: string): Promise<{
    cycleId: string;
    totalWorkItems: number;
    completedWorkItems: number;
    pendingWorkItems: number;
    velocityRate: number;
  }> {
    const items = await this.analyticsRepo.findCycleWorkItems(cycleId);
    const totalWorkItems = items.length;
    const completedWorkItems = items.filter((t) => t.completed).length;
    const pendingWorkItems = totalWorkItems - completedWorkItems;
    const velocityRate =
      totalWorkItems > 0 ? Math.round((completedWorkItems / totalWorkItems) * 100) : 0;

    return {
      cycleId,
      totalWorkItems,
      completedWorkItems,
      pendingWorkItems,
      velocityRate,
    };
  }
}
