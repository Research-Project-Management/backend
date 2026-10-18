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

