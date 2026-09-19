import { Injectable, NotFoundException } from '@nestjs/common';
import { OverviewRepository } from './overview.repository';
import { ProjectOverviewResponseDto } from './dto/project-overview-response.dto';

@Injectable()
export class OverviewService {
  constructor(private readonly overviewRepo: OverviewRepository) {}

  async getProjectOverview(
    projectId: string,
  ): Promise<ProjectOverviewResponseDto> {
    const projectMeta = await this.overviewRepo.getProjectMetadata(projectId);
    if (!projectMeta) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const [
      stateCounts,
      overdueCount,
      activeCycleData,
      recentActivities,
      latestStatusUpdate,
    ] = await Promise.all([
      this.overviewRepo.getWorkItemStateGroupCounts(projectId),
      this.overviewRepo.getOverdueCount(projectId),
      this.overviewRepo.getActiveCycle(projectId),
      this.overviewRepo.getRecentActivities(projectId, 10),
      this.overviewRepo.getLatestStatusUpdate(projectId),
    ]);

    const backlog = stateCounts.backlog || 0;
    const unstarted = stateCounts.unstarted || 0;
    const started = stateCounts.started || 0;
    const completed = stateCounts.completed || 0;
    const cancelled = stateCounts.cancelled || 0;

    const totalIssues = backlog + unstarted + started + completed + cancelled;
    const totalWorkItems = totalIssues;
    const actionableTotal = backlog + unstarted + started + completed;
    const completionPercentage =
      actionableTotal > 0
        ? parseFloat(((completed / actionableTotal) * 100).toFixed(1))
        : 0;

    let activeCycleDto = null;
    if (activeCycleData?.activeCycle) {
      const cycle = activeCycleData.activeCycle;
      const cycleTotal = cycle._count?.workItems || 0;
      const cycleCompleted = activeCycleData.completedIssues || 0;
      const cyclePercentage =
        cycleTotal > 0
          ? parseFloat(((cycleCompleted / cycleTotal) * 100).toFixed(1))
          : 0;

      let daysRemaining: number | null = null;
      if (cycle.endDate) {
        const diffMs = new Date(cycle.endDate).getTime() - new Date().getTime();
        daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      }

      activeCycleDto = {
        id: cycle.id,
        name: cycle.name,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
        daysRemaining,
        totalIssues: cycleTotal,
        completedIssues: cycleCompleted,
        completionPercentage: cyclePercentage,
      };
    }

    return {
      project: {
        id: projectMeta.id,
        name: projectMeta.name,
        identifier: projectMeta.identifier,
        description: projectMeta.description,
        avatar: projectMeta.avatar,
        coverImage: projectMeta.coverImage,
        state: projectMeta.state,
        priority: projectMeta.priority,
        startDate: projectMeta.startDate,
        targetDate: projectMeta.targetDate,
        totalMembers:
          projectMeta._count?.members || projectMeta.members?.length || 0,
        lead: projectMeta.createdBy
          ? {
              id: projectMeta.createdBy.id,
              name: projectMeta.createdBy.name,
              avatar: projectMeta.createdBy.avatar,
            }
          : null,
        members: (projectMeta.members || []).map((m: any) => ({
          id: m.user?.id || m.id,
          name: m.user?.name || 'Member',
          avatar: m.user?.avatar || null,
          role: m.role || 'contributor',
        })),
      },
      links: (projectMeta.links || []).map((link) => ({
        id: link.id,
        projectId: link.projectId,
        title: link.title,
        url: link.url,
        createdById: link.createdById,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
      })),
      metrics: {
        totalIssues,
        totalWorkItems,
        completed,
        started,
        unstarted,
        backlog,
        cancelled,
        overdue: overdueCount,
        completionPercentage,
      },
      activeCycle: activeCycleDto,
      recentActivities: (recentActivities || []).map((act) => ({
        id: act.id,
        verb: act.verb,
        field: act.field,
        oldValue: act.oldValue,
        newValue: act.newValue,
        oldIdentifier: act.oldIdentifier,
        newIdentifier: act.newIdentifier,
        createdAt: act.createdAt,
        actor: {
          id: act.actor?.id,
          name: act.actor?.name || null,
          avatar: act.actor?.avatar || null,
        },
      })),
      currentUpdate: latestStatusUpdate
        ? {
            id: latestStatusUpdate.id,
            status: latestStatusUpdate.status,
            message: latestStatusUpdate.message,
            createdAt: latestStatusUpdate.createdAt,
            author: {
              id: latestStatusUpdate.createdBy.id,
              name: latestStatusUpdate.createdBy.name,
              avatar: latestStatusUpdate.createdBy.avatar,
            },
          }
        : null,
    };
  }
}
