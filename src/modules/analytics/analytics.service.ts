import { Injectable } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { RedisCacheService } from '@/core';
import {
  ProjectWorkItemDistributionDto,
  ProjectOverviewDto,
  UserOverviewDto,
} from './dto/analytics.dto';
import { aggregateProjectDistributions } from './utils/analytics.utils';

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
        const items =
          await this.analyticsRepo.findProjectWorkItemsWithAssignees(projectId);
        return aggregateProjectDistributions(items);
      },
      300, // 5 min TTL
    );
  }

  /**
   * Project Dimensional Overview (members, workItems, pages, files, stickies)
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
  async getUserOverview(userId: string): Promise<{ stats: UserOverviewDto }> {
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
    const items =
      await this.analyticsRepo.findProjectWorkItemsByLabel(projectId);
    const labelCount: Record<string, number> = {};
    for (const item of items) {
      const relationalLabels = Array.isArray(item.labelAssignments)
        ? item.labelAssignments
            .map((a) => a.label?.name)
            .filter((name): name is string => Boolean(name))
        : [];
      const itemLabels =
        relationalLabels.length > 0
          ? relationalLabels
          : Array.isArray(item.labels)
            ? item.labels
            : [];
      const uniqueLabels = new Set(itemLabels.filter(Boolean));
      for (const label of uniqueLabels) {
        labelCount[label] = (labelCount[label] || 0) + 1;
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
}

