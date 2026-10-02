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
      recentActivities,
      latestStatusUpdate,
      cycleData,
    ] = await Promise.all([
      this.overviewRepo.getWorkItemStateGroupCounts(projectId),
      this.overviewRepo.getOverdueCount(projectId),
      this.overviewRepo.getRecentActivities(projectId, 10),
      this.overviewRepo.getLatestStatusUpdate(projectId),
      this.overviewRepo.getActiveCycle(projectId),
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

    const activeCycle = cycleData?.activeCycle
      ? {
          id: cycleData.activeCycle.id,
          name: cycleData.activeCycle.name,
          startDate: cycleData.activeCycle.startDate,
          endDate: cycleData.activeCycle.endDate,
          totalIssues: cycleData.activeCycle._count?.workItems ?? 0,
          completedIssues: cycleData.completedIssues ?? 0,
          completionPercentage:
            (cycleData.activeCycle._count?.workItems ?? 0) > 0
              ? parseFloat(
                  (
                    ((cycleData.completedIssues ?? 0) /
                      cycleData.activeCycle._count.workItems) *
                    100
                  ).toFixed(1),
                )
              : 0,
        }
      : null;

    return {
      project: {
        id: projectMeta.id,
        name: projectMeta.name,
        identifier: projectMeta.identifier,
        description: projectMeta.description,
        avatar: projectMeta.avatar,
        coverImage: projectMeta.coverImage,
        stateId: projectMeta.stateId,
        state: projectMeta.state,
        priority: projectMeta.priority,
        startDate: projectMeta.startDate,
        targetDate: projectMeta.targetDate,
        totalMembers:
          projectMeta._count?.members || projectMeta.members?.length || 0,
        lead: projectMeta.createdBy
          ? {
              id: projectMeta.createdBy.id,
              name:
                projectMeta.createdBy.profile?.name ??
                (projectMeta.createdBy as any).name ??
                'Lead',
              avatar:
                projectMeta.createdBy.profile?.avatar ??
                (projectMeta.createdBy as any).avatar ??
                null,
            }
          : null,
        members: (projectMeta.members || []).map((m: any) => ({
          id: m.user?.id || m.id,
          name: m.user?.profile?.name || m.user?.name || 'Member',
          avatar: m.user?.profile?.avatar || m.user?.avatar || null,
          role: m.role || 'contributor',
        })),
      },
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
      recentActivities: (recentActivities || []).map((act: any) => ({
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
          name: act.actor?.profile?.name || null,
          avatar: act.actor?.profile?.avatar || null,
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
              name: latestStatusUpdate.createdBy.profile?.name ?? 'User',
              avatar: latestStatusUpdate.createdBy.profile?.avatar ?? null,
            },
          }
        : null,
      activeCycle,
    };
  }
}
