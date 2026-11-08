import { Injectable } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { RedisCacheService } from '@/core';
import {
  ProjectWorkItemDistributionDto,
  ProjectOverviewDto,
  UserOverviewDto,
} from './dto/analytics.dto';
import {
  aggregateLabelDistribution,
  aggregateProjectDistributions,
  buildWorkItemTimeSeries,
} from './domain/analytics.domain';
import { LabelDistributionItem, TimeSeriesPoint } from './types/analytics.types';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly analyticsRepo: AnalyticsRepository,
    private readonly cache: RedisCacheService,
  ) {}

  /**
   * Project Dimensional Analytics (KPIs, State Columns, State Groups, Priority, Member Workload, Labels)
   */
  async getProjectAnalytics(
    projectId: string,
  ): Promise<ProjectWorkItemDistributionDto> {
    const cacheKey = `flux:analytics:proj:${projectId}:insights`;

    return this.cache.wrap(
      cacheKey,
      async () => {
        const [items, states] = await Promise.all([
          this.analyticsRepo.findProjectWorkItemsWithAssignees(projectId),
          this.analyticsRepo.findProjectStates(projectId),
        ]);
        return aggregateProjectDistributions(items, states);
      },
      300,
    );
  }

  /**
   * Project Dimensional Overview counts (members, workItems, pages, files, stickies, papers)
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

  /** Label distribution: { id?, label, color?, count }[] for a project */
  async getLabelDistribution(
    projectId: string,
  ): Promise<{ labels: LabelDistributionItem[] }> {
    const items =
      await this.analyticsRepo.findProjectWorkItemsByLabel(projectId);
    const labels = aggregateLabelDistribution(items);
    return { labels };
  }

  /**
   * Time-series: work items created and completed per day.
   */
  async getTimeSeries(
    projectId: string,
    from: string,
    to: string,
  ): Promise<{
    series: TimeSeriesPoint[];
  }> {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const items = await this.analyticsRepo.findProjectWorkItemsTimeSeries(
      projectId,
      fromDate,
      toDate,
    );

    const series = buildWorkItemTimeSeries(items, fromDate, toDate);
    return { series };
  }
}
