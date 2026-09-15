/**
 * Analytics Domain Utilities
 *
 * Pure, stateless functions for metric aggregation, distribution calculations, and burndown stats.
 */

import {
  AssigneeDistributionItem,
  ProjectDistributionResult,
} from '../types/analytics.types';

export interface WorkItemWithAssigneeInfo {
  columnId?: string | null;
  priority?: string | null;
  completed?: boolean;
  assigneeId?: string | null;
  assignee?: {
    name?: string | null;
    avatar?: string | null;
  } | null;
}

export interface CycleWorkItemMetricSource {
  columnId?: string | null;
  completed?: boolean;
}

/**
 * Aggregates work items into dimensional distributions (state column, priority level, assignee).
 */
export function aggregateProjectDistributions(
  workItems: WorkItemWithAssigneeInfo[],
): ProjectDistributionResult {
  const totalItems = workItems.length;
  const completedItems = workItems.filter((i) => Boolean(i.completed)).length;
  const completionRate =
    totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  const stateDistribution: Record<string, number> = {};
  const priorityDistribution: Record<string, number> = {};
  const assigneeMap = new Map<string, AssigneeDistributionItem>();

  for (const item of workItems) {
    // State / Column distribution
    const columnId = item.columnId || 'unassigned';
    stateDistribution[columnId] = (stateDistribution[columnId] || 0) + 1;

    // Priority level distribution
    const priorityLevel = item.priority || 'none';
    priorityDistribution[priorityLevel] =
      (priorityDistribution[priorityLevel] || 0) + 1;

    // Assignee workload distribution
    if (item.assigneeId && item.assignee) {
      const existingAssignee = assigneeMap.get(item.assigneeId) || {
        userId: item.assigneeId,
        name: item.assignee.name || 'Anonymous',
        avatar: item.assignee.avatar ?? null,
        count: 0,
      };
      existingAssignee.count += 1;
      assigneeMap.set(item.assigneeId, existingAssignee);
    }
  }

  return {
    totalItems,
    completedItems,
    completionRate,
    state: stateDistribution,
    priority: priorityDistribution,
    assignee: Array.from(assigneeMap.values()),
  };
}

/**
 * Calculates sprint cycle metrics including completion rate and progress distribution.
 */
export function calculateCycleMetrics(
  cycleId: string,
  workItems: CycleWorkItemMetricSource[],
) {
  const totalWorkItems = workItems.length;
  const completedWorkItems = workItems.filter((item) => item.completed).length;
  const inProgressWorkItems = workItems.filter(
    (item) =>
      item.columnId === 'doing' ||
      item.columnId === 'in_progress' ||
      item.columnId === 'review' ||
      item.columnId === 'in_review',
  ).length;
  const pendingWorkItems = Math.max(
    0,
    totalWorkItems - completedWorkItems - inProgressWorkItems,
  );
  const completionRate =
    totalWorkItems > 0
      ? Math.round((completedWorkItems / totalWorkItems) * 100)
      : 0;

  return {
    cycleId,
    totalWorkItems,
    completedWorkItems,
    inProgressWorkItems,
    pendingWorkItems,
    completionRate,
  };
}
