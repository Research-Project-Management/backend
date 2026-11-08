/**
 * Your Work Pure Domain Logic
 *
 * Stateless domain classification, state-group resolution, activity feed formatting,
 * and cross-project workload aggregation.
 */

import { inferStateGroup, type StateGroup } from '@/modules/project/work-item';
import {
  ActivityFeedItem,
  ProjectMinimal,
  ProjectWorkloadBreakdown,
  UserWorkItem,
  YourWorkActivityItem,
} from '../types/your-work.types';

/**
 * Normalizes optional projectId scope, returning undefined when targeting personal space.
 */
export function normalizeYourWorkScopeProjectId(
  rawProjectId: string | undefined,
  userId?: string,
): string | undefined {
  const trimmed = rawProjectId?.trim();
  if (
    !trimmed ||
    ['personal', 'me', 'user', 'null', 'undefined', 'default', ''].includes(
      trimmed.toLowerCase(),
    ) ||
    (userId && trimmed.toLowerCase() === userId.trim().toLowerCase())
  ) {
    return undefined;
  }
  return trimmed;
}

export function isUserAssignedToWorkItem(
  item: UserWorkItem,
  userId: string,
): boolean {
  if (item.assigneeId === userId) return true;
  if (
    Array.isArray(item.assigneeIds) &&
    (item.assigneeIds as string[]).includes(userId)
  ) {
    return true;
  }
  return false;
}

export function isUserSubscribedToWorkItem(
  item: UserWorkItem,
  userId: string,
): boolean {
  if (isUserAssignedToWorkItem(item, userId) || item.authorId === userId) {
    return false;
  }
  if (
    Array.isArray(item.subscriberIds) &&
    (item.subscriberIds as string[]).includes(userId)
  ) {
    return true;
  }
  return (item.comments?.length || 0) > 0;
}

export function resolveWorkItemStateGroup(item: UserWorkItem): StateGroup {
  let colName = item.columnId;
  const states = item.project?.states;
  if (Array.isArray(states)) {
    const matched = (states as Array<Record<string, unknown>>).find(
      (c) => c.id === item.columnId,
    );
    if (matched?.group && typeof matched.group === 'string') {
      return matched.group as StateGroup;
    }
    if (typeof matched?.name === 'string') {
      colName = matched.name;
    }
  }
  return inferStateGroup(item.columnId, colName);
}

export function formatYourWorkActivities(
  items: ActivityFeedItem[],
  userId: string,
): YourWorkActivityItem[] {
  return (items || []).map((activityEvent) => {
    const isYou = activityEvent.actorId === userId;
    return {
      id: activityEvent.id,
      type: `${activityEvent.entityType}_${activityEvent.verb}`,
      actorName: isYou ? 'You' : activityEvent.actor?.name || 'A member',
      actionVerb: activityEvent.verb,
      targetIdentifier: activityEvent.field || null,
      targetTitle: activityEvent.newValue || activityEvent.entityId,
      content: `${isYou ? 'You' : activityEvent.actor?.name || 'Member'} ${activityEvent.verb} ${activityEvent.entityType}`,
      time: activityEvent.createdAt.toISOString(),
      itemId: activityEvent.entityId,
      user: activityEvent.actor
        ? {
            name: activityEvent.actor.name || '',
            avatar: activityEvent.actor.avatar || null,
          }
        : undefined,
      project: activityEvent.projectId
        ? {
            id: activityEvent.projectId,
            name: activityEvent.project?.name || '',
          }
        : undefined,
    };
  });
}

export function aggregateYourWorkBreakdowns(params: {
  assigned: UserWorkItem[];
  created: UserWorkItem[];
  subscribed: UserWorkItem[];
  projectList: ProjectMinimal[];
}): {
  stateGroupBreakdown: Record<string, number>;
  subscribedStateGroupBreakdown: Record<string, number>;
  priorityBreakdown: Record<string, number>;
  projectBreakdown: ProjectWorkloadBreakdown[];
} {
  const { assigned, created, subscribed, projectList } = params;

  const stateGroupBreakdown: Record<string, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
  };

  const subscribedStateGroupBreakdown: Record<string, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
  };

  const priorityBreakdown: Record<string, number> = {
    urgent: 0,
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
  };

  assigned.forEach((item) => {
    const group = resolveWorkItemStateGroup(item);
    stateGroupBreakdown[group] = (stateGroupBreakdown[group] || 0) + 1;

    const prio = (item.priority || 'none').toLowerCase();
    priorityBreakdown[prio] = (priorityBreakdown[prio] || 0) + 1;
  });

  subscribed.forEach((item) => {
    const group = resolveWorkItemStateGroup(item);
    subscribedStateGroupBreakdown[group] =
      (subscribedStateGroupBreakdown[group] || 0) + 1;
  });

  const projectMap = new Map<
    string,
    {
      id: string;
      name: string;
      identifier: string | null;
      avatar: string | null;
      states?: unknown;
      assigned: UserWorkItem[];
      created: UserWorkItem[];
      subscribed: UserWorkItem[];
    }
  >();

  (projectList || []).forEach((p) => {
    projectMap.set(p.id, {
      id: p.id,
      name: p.name,
      identifier: p.identifier,
      avatar: p.avatar,
      states: p.states,
      assigned: [],
      created: [],
      subscribed: [],
    });
  });

  const registerProjectWorkItem = (
    item: UserWorkItem,
    category: 'assigned' | 'created' | 'subscribed',
  ) => {
    if (!item.projectId) return;
    if (!projectMap.has(item.projectId)) {
      projectMap.set(item.projectId, {
        id: item.projectId,
        name: item.project?.name || 'Untitled Project',
        identifier: item.project?.identifier || null,
        avatar: item.project?.avatar || null,
        states: item.project?.states,
        assigned: [],
        created: [],
        subscribed: [],
      });
    }
    projectMap.get(item.projectId)![category].push(item);
  };

  assigned.forEach((t) => registerProjectWorkItem(t, 'assigned'));
  created.forEach((t) => registerProjectWorkItem(t, 'created'));
  subscribed.forEach((t) => registerProjectWorkItem(t, 'subscribed'));

  const projectBreakdown: ProjectWorkloadBreakdown[] = Array.from(
    projectMap.values(),
  )
    .map((p) => {
      const pAssignedStateGroup: Record<StateGroup, number> = {
        backlog: 0,
        unstarted: 0,
        started: 0,
        completed: 0,
        cancelled: 0,
      };
      p.assigned.forEach((t) => {
        const group = resolveWorkItemStateGroup(t);
        pAssignedStateGroup[group] = (pAssignedStateGroup[group] || 0) + 1;
      });

      const pSubscribedStateGroup: Record<StateGroup, number> = {
        backlog: 0,
        unstarted: 0,
        started: 0,
        completed: 0,
        cancelled: 0,
      };
      p.subscribed.forEach((t) => {
        const group = resolveWorkItemStateGroup(t);
        pSubscribedStateGroup[group] =
          (pSubscribedStateGroup[group] || 0) + 1;
      });

      const totalActiveOrDone =
        pAssignedStateGroup.completed +
        pAssignedStateGroup.started +
        pAssignedStateGroup.unstarted +
        pAssignedStateGroup.backlog;

      const completionRate =
        totalActiveOrDone > 0
          ? Math.round(
              (pAssignedStateGroup.completed / totalActiveOrDone) * 100,
            )
          : 0;

      return {
        projectId: p.id,
        projectName: p.name,
        projectIdentifier: p.identifier,
        projectAvatar: p.avatar,
        assignedCount: p.assigned.length,
        createdCount: p.created.length,
        subscribedCount: p.subscribed.length,
        totalCount:
          p.assigned.length + p.created.length + p.subscribed.length,
        stateGroupBreakdown: pAssignedStateGroup,
        subscribedStateGroupBreakdown: pSubscribedStateGroup,
        completionRate,
      };
    })
    .sort(
      (a, b) =>
        b.assignedCount - a.assignedCount || b.totalCount - a.totalCount,
    );

  return {
    stateGroupBreakdown,
    subscribedStateGroupBreakdown,
    priorityBreakdown,
    projectBreakdown,
  };
}
