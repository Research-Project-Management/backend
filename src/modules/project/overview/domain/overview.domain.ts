/**
 * Project Overview Pure Domain Logic
 *
 * Stateless domain aggregation for project overview metrics, metadata,
 * recent activity formatting, and latest status updates.
 */

import {
  ProjectOverviewActivityDto,
  ProjectOverviewMetricsDto,
  ProjectOverviewProjectDto,
  ProjectOverviewResponseDto,
  ProjectOverviewStatusUpdateDto,
} from '../dto/project-overview-response.dto';
import {
  OverviewRawActivity,
  OverviewRawMetadata,
  OverviewRawStatusUpdate,
  ProjectOverviewAssets,
} from '../types/overview.types';

export function computeOverviewMetrics(
  stateCounts: Record<string, number>,
  overdueCount: number,
): ProjectOverviewMetricsDto {
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

  return {
    totalIssues,
    totalWorkItems,
    completed,
    started,
    unstarted,
    backlog,
    cancelled,
    overdue: overdueCount,
    completionPercentage,
  };
}

export function mapOverviewProjectMetadata(
  projectMeta: OverviewRawMetadata,
): ProjectOverviewProjectDto {
  return {
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
          name: projectMeta.createdBy.profile?.name ?? 'Lead',
          avatar: projectMeta.createdBy.profile?.avatar ?? null,
        }
      : null,
    members: (projectMeta.members || []).map((m) => ({
      id: m.user?.id || m.userId,
      name: m.user?.profile?.name || 'Member',
      avatar: m.user?.profile?.avatar || null,
      role: String(m.role || 'contributor'),
    })),
  };
}

export function mapOverviewActivities(
  recentActivities: OverviewRawActivity[],
): ProjectOverviewActivityDto[] {
  return (recentActivities || []).map((act) => ({
    id: act.id,
    verb: act.verb,
    field: act.field,
    oldValue: act.oldValue,
    newValue: act.newValue,
    oldIdentifier: act.oldIdentifier,
    newIdentifier: act.newIdentifier,
    createdAt: act.createdAt,
    actor: {
      id: act.actor?.id || '',
      name: act.actor?.profile?.name || null,
      avatar: act.actor?.profile?.avatar || null,
    },
  }));
}

export function mapOverviewStatusUpdate(
  latestStatusUpdate: OverviewRawStatusUpdate | null,
): ProjectOverviewStatusUpdateDto | null {
  if (!latestStatusUpdate) return null;
  return {
    id: latestStatusUpdate.id,
    status: latestStatusUpdate.status,
    message: latestStatusUpdate.message,
    createdAt: latestStatusUpdate.createdAt,
    author: {
      id: latestStatusUpdate.createdBy.id,
      name: latestStatusUpdate.createdBy.profile?.name ?? 'User',
      avatar: latestStatusUpdate.createdBy.profile?.avatar ?? null,
    },
  };
}

export function assembleProjectOverviewResponse(params: {
  projectMeta: OverviewRawMetadata;
  stateCounts: Record<string, number>;
  overdueCount: number;
  recentActivities: OverviewRawActivity[];
  latestStatusUpdate: OverviewRawStatusUpdate | null;
  assets: ProjectOverviewAssets;
}): ProjectOverviewResponseDto {
  return {
    project: mapOverviewProjectMetadata(params.projectMeta),
    metrics: computeOverviewMetrics(params.stateCounts, params.overdueCount),
    assets: params.assets,
    recentActivities: mapOverviewActivities(params.recentActivities),
    currentUpdate: mapOverviewStatusUpdate(params.latestStatusUpdate),
  };
}
