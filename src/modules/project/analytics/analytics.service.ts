import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectAnalyticsRepository } from './analytics.repository';
import { ProjectPortfolioOverviewDto } from './dto/project-analytics.dto';

@Injectable()
export class ProjectAnalyticsService {
  constructor(private readonly analyticsRepo: ProjectAnalyticsRepository) {}

  /**
   * Calculate high-level portfolio overview metrics for a project:
   * % complete, work item counts by group, timeline deadline status.
   */
  async getProjectOverview(projectId: string): Promise<ProjectPortfolioOverviewDto> {
    const project = await this.analyticsRepo.getProjectWithMetadata(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const stateCounts = await this.analyticsRepo.getWorkItemsCountsByStateGroup(projectId);
    const activeCycle = await this.analyticsRepo.getActiveCycle(projectId);

    const backlog = stateCounts.backlog || 0;
    const unstarted = stateCounts.unstarted || 0;
    const started = stateCounts.started || 0;
    const completed = stateCounts.completed || 0;
    const cancelled = stateCounts.cancelled || 0;

    const totalWorkItems = backlog + unstarted + started + completed + cancelled;
    const actionableTotal = totalWorkItems - cancelled;
    const completionPercentage =
      actionableTotal > 0 ? Number(((completed / actionableTotal) * 100).toFixed(1)) : 0;

    // Timeline calculations
    let daysRemaining: number | null = null;
    let isOverdue = false;

    if (project.targetDate) {
      const now = new Date();
      const target = new Date(project.targetDate);
      const diffMs = target.getTime() - now.getTime();
      daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      isOverdue = daysRemaining < 0 && project.state !== 'completed';
    }

    return {
      projectId: project.id,
      name: project.name,
      state: project.state,
      priority: project.priority,
      startDate: project.startDate,
      targetDate: project.targetDate,
      daysRemaining,
      isOverdue,
      totalWorkItems,
      completedWorkItems: completed,
      inProgressWorkItems: started,
      backlogWorkItems: backlog + unstarted,
      completionPercentage,
      totalMembers: project._count.members,
      totalCycles: project._count.cycles,
      activeCycle,
    };
  }

  /**
   * Detailed breakdown across dimensions (Priority, State Group, Assignee)
   */
  async getProjectDetailedBreakdown(projectId: string) {
    const items = await this.analyticsRepo.getWorkItemsDetailed(projectId);

    const byPriority: Record<string, number> = {};
    const byStateGroup: Record<string, number> = {};
    const byState: Record<string, { id: string; name: string; color: string; count: number }> = {};
    const byAssignee: Record<string, number> = {};

    for (const item of items) {
      // Priority
      const p = item.priority || 'none';
      byPriority[p] = (byPriority[p] || 0) + 1;

      // State group
      const grp = item.state?.group || 'backlog';
      byStateGroup[grp] = (byStateGroup[grp] || 0) + 1;

      // Specific state
      if (item.state) {
        if (!byState[item.state.id]) {
          byState[item.state.id] = {
            id: item.state.id,
            name: item.state.name,
            color: item.state.color,
            count: 0,
          };
        }
        byState[item.state.id].count += 1;
      }

      // Assignee
      const a = item.assigneeId || 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }

    return {
      totalItems: items.length,
      byPriority,
      byStateGroup,
      byState: Object.values(byState),
      byAssignee,
    };
  }
}
