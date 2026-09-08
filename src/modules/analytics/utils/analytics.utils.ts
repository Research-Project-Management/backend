/**
 * Analytics Domain Utilities
 *
 * Pure, stateless functions for metric aggregation, distribution calculations, and burndown stats.
 */

import {
  AssigneeDistributionItem,
  ProjectDistributionResult,
} from '../types/analytics.types';

export interface TaskWithAssigneeInfo {
  columnId?: string | null;
  priority?: string | null;
  assigneeId?: string | null;
  assignee?: {
    name?: string | null;
    avatar?: string | null;
  } | null;
}

export interface CycleTaskMetricSource {
  columnId?: string | null;
  completed?: boolean;
}

/**
 * Aggregates tasks into dimensional distributions (state column, priority level, assignee).
 */
export function aggregateProjectDistributions(
  tasks: TaskWithAssigneeInfo[],
): ProjectDistributionResult {
  const stateDistribution: Record<string, number> = {};
  const priorityDistribution: Record<string, number> = {};
  const assigneeMap = new Map<string, AssigneeDistributionItem>();

  for (const task of tasks) {
    // State / Column distribution
    const taskColumnId = task.columnId || 'unassigned';
    stateDistribution[taskColumnId] =
      (stateDistribution[taskColumnId] || 0) + 1;

    // Priority level distribution
    const priorityLevel = task.priority || 'none';
    priorityDistribution[priorityLevel] =
      (priorityDistribution[priorityLevel] || 0) + 1;

    // Assignee workload distribution
    if (task.assigneeId && task.assignee) {
      const existingAssignee = assigneeMap.get(task.assigneeId) || {
        userId: task.assigneeId,
        name: task.assignee.name || 'Anonymous',
        avatar: task.assignee.avatar ?? null,
        count: 0,
      };
      existingAssignee.count += 1;
      assigneeMap.set(task.assigneeId, existingAssignee);
    }
  }

  return {
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
  tasks: CycleTaskMetricSource[],
) {
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter((task) => task.completed).length;
  const inProgressTasks = tasks.filter(
    (task) =>
      task.columnId === 'doing' ||
      task.columnId === 'in_progress' ||
      task.columnId === 'review' ||
      task.columnId === 'in_review',
  ).length;
  const pendingTasks = Math.max(
    0,
    totalTasks - completedTasks - inProgressTasks,
  );
  const completionRate =
    totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  return {
    cycleId,
    totalTasks,
    completedTasks,
    inProgressTasks,
    pendingTasks,
    completionRate,
  };
}
