/**
 * Project Analytics Pure Domain Logic
 *
 * Pure, stateless functions for metric aggregation, state-group breakdown,
 * priority distribution, member workload, label distribution, and time-series trends.
 */

import {
  AssigneeDistributionItem,
  LabelDistributionItem,
  ProjectDistributionResult,
  RawAnalyticsWorkItem,
  RawProjectStateColumn,
  StateColumnBreakdownItem,
  TimeSeriesPoint,
} from '../types/analytics.types';

/**
 * Aggregates project work items into comprehensive dimensional distributions:
 * - KPI totals (total, completed, in-progress, overdue, unassigned, completionRate)
 * - State column counts (`state`) & ordered column metadata (`states`)
 * - Canonical 5-state-group breakdown (`stateGroups`)
 * - Priority distribution (`priority`)
 * - Member workload (`assignee`) with completed, in-progress, and overdue counts
 * - Label distribution (`labels`)
 */
export function aggregateProjectDistributions(
  workItems: RawAnalyticsWorkItem[],
  projectStates: RawProjectStateColumn[] = [],
  now: Date = new Date(),
): ProjectDistributionResult {
  const totalItems = workItems.length;

  const stateDistribution: Record<string, number> = {};
  const stateGroups: Record<string, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
  };
  const priorityDistribution: Record<string, number> = {
    urgent: 0,
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
  };
  const assigneeMap = new Map<string, AssigneeDistributionItem>();
  const labelMap = new Map<string, LabelDistributionItem>();

  const stateMetaMap = new Map<string, RawProjectStateColumn>();
  for (const st of projectStates) {
    stateMetaMap.set(st.id, st);
  }

  let completedItems = 0;
  let inProgressItems = 0;
  let overdueItems = 0;
  let unassignedItems = 0;

  for (const item of workItems) {
    const columnId = item.columnId || item.stateId || 'unassigned';
    stateDistribution[columnId] = (stateDistribution[columnId] || 0) + 1;

    const stateMeta = stateMetaMap.get(columnId);
    const group = (
      item.stateGroup ||
      stateMeta?.group ||
      (item.completed ? 'completed' : 'backlog')
    ).toLowerCase();

    if (group in stateGroups) {
      stateGroups[group] += 1;
    } else {
      stateGroups.backlog += 1;
    }

    const isCompleted = Boolean(item.completed) || group === 'completed';
    const isCancelled = group === 'cancelled';
    const isStarted = group === 'started';

    if (isCompleted) {
      completedItems += 1;
    }
    if (isStarted) {
      inProgressItems += 1;
    }

    const dueDate = item.dueDate ? new Date(item.dueDate) : null;
    const isOverdue = Boolean(
      dueDate &&
        !isNaN(dueDate.getTime()) &&
        dueDate < now &&
        !isCompleted &&
        !isCancelled,
    );
    if (isOverdue) {
      overdueItems += 1;
    }

    // Priority distribution
    const priorityLevel = (item.priority || 'none').toLowerCase();
    priorityDistribution[priorityLevel] =
      (priorityDistribution[priorityLevel] || 0) + 1;

    // Assignee workload distribution
    if (item.assigneeId && item.assignee) {
      const existingAssignee = assigneeMap.get(item.assigneeId) || {
        userId: item.assigneeId,
        name: item.assignee.name || 'Anonymous',
        avatar: item.assignee.avatar ?? null,
        count: 0,
        completedCount: 0,
        inProgressCount: 0,
        overdueCount: 0,
      };
      existingAssignee.count += 1;
      if (isCompleted) existingAssignee.completedCount += 1;
      if (isStarted) existingAssignee.inProgressCount += 1;
      if (isOverdue) existingAssignee.overdueCount += 1;
      assigneeMap.set(item.assigneeId, existingAssignee);
    } else {
      unassignedItems += 1;
    }

    // Label distribution
    if (Array.isArray(item.labelAssignments)) {
      const seenLabels = new Set<string>();
      for (const assignment of item.labelAssignments) {
        const labelName = assignment.label?.name?.trim();
        if (!labelName || seenLabels.has(labelName)) continue;
        seenLabels.add(labelName);
        const existingLabel = labelMap.get(labelName) || {
          id: assignment.label?.id,
          label: labelName,
          color: assignment.label?.color || '#6366f1',
          count: 0,
        };
        existingLabel.count += 1;
        labelMap.set(labelName, existingLabel);
      }
    }
  }

  const actionableTotal =
    totalItems - (stateGroups.cancelled || 0) > 0
      ? totalItems - (stateGroups.cancelled || 0)
      : totalItems;
  const completionRate =
    actionableTotal > 0
      ? Math.round((completedItems / actionableTotal) * 100)
      : 0;

  const states: StateColumnBreakdownItem[] = projectStates.map((st) => ({
    id: st.id,
    name: st.name,
    group: st.group,
    color: st.color || '#8A9093',
    count: stateDistribution[st.id] || 0,
  }));

  const assignee = Array.from(assigneeMap.values()).sort(
    (a, b) => b.count - a.count,
  );
  const labels = Array.from(labelMap.values()).sort(
    (a, b) => b.count - a.count,
  );

  return {
    totalItems,
    completedItems,
    inProgressItems,
    overdueItems,
    unassignedItems,
    completionRate,
    state: stateDistribution,
    stateGroups,
    states,
    priority: priorityDistribution,
    assignee,
    labels,
  };
}

/**
 * Pure domain aggregator for label counts across work items.
 */
export function aggregateLabelDistribution(
  items: Array<{
    labelAssignments?: Array<{
      label?: { id?: string; name?: string | null; color?: string | null } | null;
    }>;
  }>,
): LabelDistributionItem[] {
  const labelMap = new Map<string, LabelDistributionItem>();

  for (const item of items) {
    if (!Array.isArray(item.labelAssignments)) continue;
    const seen = new Set<string>();
    for (const a of item.labelAssignments) {
      const name = a.label?.name?.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const existing = labelMap.get(name) || {
        id: a.label?.id,
        label: name,
        color: a.label?.color || '#6366f1',
        count: 0,
      };
      existing.count += 1;
      labelMap.set(name, existing);
    }
  }

  return Array.from(labelMap.values()).sort((a, b) => b.count - a.count);
}

/**
 * Pure domain builder for daily work-item creation & completion time-series.
 */
export function buildWorkItemTimeSeries(
  items: Array<{
    createdAt: Date;
    updatedAt: Date;
    completed: boolean;
  }>,
  fromDate: Date,
  toDate: Date,
): TimeSeriesPoint[] {
  const dateMap: Record<string, { created: number; completed: number }> = {};
  const cursor = new Date(fromDate);
  while (cursor <= toDate) {
    dateMap[cursor.toISOString().slice(0, 10)] = { created: 0, completed: 0 };
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const item of items) {
    const createdKey = item.createdAt.toISOString().slice(0, 10);
    if (dateMap[createdKey]) {
      dateMap[createdKey].created += 1;
    }
    if (item.completed) {
      const completedKey = item.updatedAt.toISOString().slice(0, 10);
      if (dateMap[completedKey]) {
        dateMap[completedKey].completed += 1;
      }
    }
  }

  return Object.entries(dateMap).map(([date, v]) => ({ date, ...v }));
}
