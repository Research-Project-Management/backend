import { Injectable } from '@nestjs/common';
import { AnalyticsRepository } from './analytics.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import {
  ProjectTaskDistributionDto,
  CycleAnalyticsDto,
  WorkspaceStatsResponse,
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
   * Cycle / Sprint Analytics (Burndown rate & progress)
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

  /** Label distribution: { label, count }[] for a project */
  async getLabelDistribution(projectId: string): Promise<{ labels: { label: string; count: number }[] }> {
    const tasks = await this.analyticsRepo.findProjectTasksByLabel(projectId);
    const labelCount: Record<string, number> = {};
    for (const task of tasks) {
      const labels: string[] = Array.isArray(task.labels) ? (task.labels as string[]) : [];
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
   * Time-series: tasks created and completed per day.
   * @param from  ISO date string (inclusive)
   * @param to    ISO date string (inclusive)
   */
  async getTimeSeries(
    projectId: string,
    from: string,
    to: string,
  ): Promise<{ series: { date: string; created: number; completed: number }[] }> {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const tasks = await this.analyticsRepo.findProjectTasksTimeSeries(projectId, fromDate, toDate);

    const dateMap: Record<string, { created: number; completed: number }> = {};
    const cursor = new Date(fromDate);
    while (cursor <= toDate) {
      dateMap[cursor.toISOString().slice(0, 10)] = { created: 0, completed: 0 };
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const task of tasks) {
      const createdKey = (task.createdAt as Date).toISOString().slice(0, 10);
      if (dateMap[createdKey]) dateMap[createdKey].created += 1;
      if (task.completed) {
        const completedKey = (task.updatedAt as Date).toISOString().slice(0, 10);
        if (dateMap[completedKey]) dateMap[completedKey].completed += 1;
      }
    }

    const series = Object.entries(dateMap).map(([date, v]) => ({ date, ...v }));
    return { series };
  }

  /** Burn-down chart: remaining tasks per day from cycle start to today/end */
  async getCycleBurndown(cycleId: string): Promise<{
    cycleId: string;
    burndown: { date: string; remaining: number; completed: number }[];
  }> {
    const cycle = await this.analyticsRepo.findCycleById(cycleId);
    const tasks = await this.analyticsRepo.findCycleTasksWithDates(cycleId);

    const total = tasks.length;
    const startDate = cycle?.startDate ? new Date(cycle.startDate) : new Date();
    const endDate = cycle?.endDate ? new Date(cycle.endDate) : new Date();
    const today = new Date();
    const chartEnd = endDate < today ? endDate : today;

    const burndown: { date: string; remaining: number; completed: number }[] = [];
    const cursor = new Date(startDate);

    while (cursor <= chartEnd) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const completedByDay = tasks.filter(
        (t) => t.completed && new Date(t.updatedAt as Date) <= new Date(dateStr + 'T23:59:59Z'),
      ).length;
      burndown.push({ date: dateStr, remaining: total - completedByDay, completed: completedByDay });
      cursor.setDate(cursor.getDate() + 1);
    }

    return { cycleId, burndown };
  }

  /** Velocity: tasks completed vs total in a cycle */
  async getCycleVelocity(cycleId: string): Promise<{
    cycleId: string;
    totalTasks: number;
    completedTasks: number;
    pendingTasks: number;
    velocityRate: number;
  }> {
    const tasks = await this.analyticsRepo.findCycleTasks(cycleId);
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.completed).length;
    const pendingTasks = totalTasks - completedTasks;
    const velocityRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return {
      cycleId,
      totalTasks,
      completedTasks,
      pendingTasks,
      velocityRate,
    };
  }
}
