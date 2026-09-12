import { Injectable } from '@nestjs/common';
import { YourWorkRepository } from './your-work.repository';
import { ActivityService } from '@/modules/activity/activity.service';
import { YourWorkSummaryDto } from './dto/your-work.dto';
import {
  ActivityFeedItem,
  ProjectWorkloadBreakdown,
  UserWorkspaceTaskItem,
  YourWorkActivityItem,
} from './types/your-work.types';
import { inferStateGroup } from '@/modules/work-item/state/utils/state.util';
import type { StateGroup } from '@/modules/work-item/state/types/state.types';

@Injectable()
export class YourWorkService {
  constructor(
    private readonly yourWorkRepo: YourWorkRepository,
    private readonly activityService: ActivityService,
  ) {}

  /**
   * Your Workload & Activity Aggregator
   */
  async getYourWork(
    workspaceId: string,
    userId: string,
  ): Promise<YourWorkSummaryDto> {
    const [tasks, activityFeed, recentItems, userProfile, workspaceProjects] =
      await Promise.all([
        this.yourWorkRepo.findUserWorkspaceTasks(workspaceId, userId),
        this.activityService.getActivityFeed(workspaceId, { limit: 20 }),
        this.activityService.getRecentItems(workspaceId, userId, 10),
        this.yourWorkRepo.findUserProfile(userId),
        this.yourWorkRepo.findUserWorkspaceProjects(workspaceId, userId),
      ]);

    const assigned = tasks.filter((taskItem) => taskItem.assigneeId === userId);
    const created = tasks.filter((taskItem) => taskItem.authorId === userId);
    const subscribed = tasks.filter(
      (taskItem) =>
        taskItem.assigneeId !== userId &&
        taskItem.authorId !== userId &&
        (taskItem.comments?.length || 0) > 0,
    );

    const formattedActivities: YourWorkActivityItem[] = (
      activityFeed.items as ActivityFeedItem[]
    ).map((activityEvent) => {
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

    const resolveTaskStateGroup = (
      taskItem: UserWorkspaceTaskItem,
    ): StateGroup => {
      let colName = taskItem.columnId;
      if (Array.isArray(taskItem.project?.taskColumns)) {
        const matched = (
          taskItem.project.taskColumns as Array<Record<string, unknown>>
        ).find((c) => c.id === taskItem.columnId);
        if (matched?.title || matched?.name) {
          colName = String(matched.title || matched.name);
        }
      }
      return inferStateGroup(taskItem.columnId, colName);
    };

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

    assigned.forEach((taskItem) => {
      const group = resolveTaskStateGroup(taskItem);
      stateGroupBreakdown[group] = (stateGroupBreakdown[group] || 0) + 1;

      const prio = (taskItem.priority || 'none').toLowerCase();
      priorityBreakdown[prio] = (priorityBreakdown[prio] || 0) + 1;
    });

    subscribed.forEach((taskItem) => {
      const group = resolveTaskStateGroup(taskItem);
      subscribedStateGroupBreakdown[group] =
        (subscribedStateGroupBreakdown[group] || 0) + 1;
    });

    // Group tasks per project to compute project-level workload & progress
    const projectMap = new Map<
      string,
      {
        id: string;
        name: string;
        identifier: string | null;
        avatar: string | null;
        taskColumns?: unknown;
        assigned: UserWorkspaceTaskItem[];
        created: UserWorkspaceTaskItem[];
        subscribed: UserWorkspaceTaskItem[];
      }
    >();

    // 1. Seed projectMap with all active workspace projects
    (workspaceProjects || []).forEach((p) => {
      projectMap.set(p.id, {
        id: p.id,
        name: p.name,
        identifier: p.identifier,
        avatar: p.avatar,
        taskColumns: p.taskColumns,
        assigned: [],
        created: [],
        subscribed: [],
      });
    });

    const registerProjectTask = (
      taskItem: UserWorkspaceTaskItem,
      category: 'assigned' | 'created' | 'subscribed',
    ) => {
      if (!taskItem.projectId) return;
      if (!projectMap.has(taskItem.projectId)) {
        projectMap.set(taskItem.projectId, {
          id: taskItem.projectId,
          name: taskItem.project?.name || 'Untitled Project',
          identifier: taskItem.project?.identifier || null,
          avatar: taskItem.project?.avatar || null,
          taskColumns: taskItem.project?.taskColumns,
          assigned: [],
          created: [],
          subscribed: [],
        });
      }
      projectMap.get(taskItem.projectId)![category].push(taskItem);
    };

    assigned.forEach((t) => registerProjectTask(t, 'assigned'));
    created.forEach((t) => registerProjectTask(t, 'created'));
    subscribed.forEach((t) => registerProjectTask(t, 'subscribed'));

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
          const group = resolveTaskStateGroup(t);
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
          const group = resolveTaskStateGroup(t);
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
      workspaceId,
      userId,
      assigned,
      created,
      subscribed,
      activity: formattedActivities,
      recent: recentItems,
      stateGroupBreakdown,
      subscribedStateGroupBreakdown,
      priorityBreakdown,
      projectBreakdown,
      userData: userProfile
        ? {
            ...userProfile,
            createdAt:
              userProfile.createdAt instanceof Date
                ? userProfile.createdAt.toISOString()
                : String(userProfile.createdAt),
          }
        : undefined,
      success: true,
    };
  }
}
