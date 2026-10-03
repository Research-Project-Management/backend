import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { YourWorkRepository } from './your-work.repository';
import { ActivityService } from '@/modules/activity/activity.service';
import { YourWorkSummaryDto } from './dto/your-work.dto';
import {
  ActivityFeedItem,
  ProjectWorkloadBreakdown,
  UserWorkItem,
  YourWorkActivityItem,
} from './types/your-work.types';
import { inferStateGroup } from '@/modules/work-item/state/utils/state.util';
import type { StateGroup } from '@/modules/work-item/state/types/state.types';

@Injectable()
export class YourWorkService {
  private readonly logger = new Logger(YourWorkService.name);

  constructor(
    private readonly yourWorkRepo: YourWorkRepository,
    private readonly activityService: ActivityService,
  ) {}

  /**
   * Generates a fully zeroed-out structured payload for empty states
   */
  private async buildEmptyYourWork(
    projectId: string | undefined,
    userId: string,
  ): Promise<YourWorkSummaryDto> {
    const userProfile = await this.yourWorkRepo.findUserProfile(userId);
    return {
      projectId,
      userId,
      assigned: [],
      created: [],
      subscribed: [],
      activity: [],
      recent: [],
      stateGroupBreakdown: {
        backlog: 0,
        unstarted: 0,
        started: 0,
        completed: 0,
        cancelled: 0,
      },
      subscribedStateGroupBreakdown: {
        backlog: 0,
        unstarted: 0,
        started: 0,
        completed: 0,
        cancelled: 0,
      },
      priorityBreakdown: {
        urgent: 0,
        high: 0,
        medium: 0,
        low: 0,
        none: 0,
      },
      projectBreakdown: [],
      userData: userProfile
        ? {
            ...userProfile,
            createdAt:
              userProfile.createdAt instanceof Date
                ? userProfile.createdAt.toISOString()
                : String(userProfile.createdAt),
          }
        : undefined,
      isEmpty: true,
      success: true,
    };
  }

  /**
   * Your Workload & Activity Aggregator
   */
  async getYourWork(
    projectId: string | undefined,
    userId: string,
    forceEmpty = false,
  ): Promise<YourWorkSummaryDto> {
    if (forceEmpty) {
      return this.buildEmptyYourWork(projectId, userId);
    }

    if (projectId) {
      const accessCheck = await this.yourWorkRepo.checkProjectAccess(
        projectId,
        userId,
      );
      if (!accessCheck.exists) {
        throw new NotFoundException(
          `Project with ID "${projectId}" was not found`,
        );
      }
      if (!accessCheck.hasAccess) {
        throw new ForbiddenException(
          'You do not have permission to access this project workload',
        );
      }
    }

    const [workItems, activityFeed, recentItems, userProfile, projectList] =
      await Promise.all([
        this.yourWorkRepo.findUserWorkItems(projectId, userId),
        projectId
          ? this.activityService.getProjectFeed(projectId, { limit: 20 })
          : this.activityService.getUserFeed(userId, { limit: 20 }),
        this.activityService.getRecentItems(projectId, userId, 10),
        this.yourWorkRepo.findUserProfile(userId),
        this.yourWorkRepo.findUserProjects(projectId, userId),
      ]);

    const isUserAssigned = (item: UserWorkItem) => {
      if (item.assigneeId === userId) return true;
      if (
        Array.isArray(item.assigneeIds) &&
        (item.assigneeIds as string[]).includes(userId)
      ) {
        return true;
      }
      return false;
    };

    const isUserSubscribed = (item: UserWorkItem) => {
      if (isUserAssigned(item) || item.authorId === userId) return false;
      if (
        Array.isArray(item.subscriberIds) &&
        (item.subscriberIds as string[]).includes(userId)
      ) {
        return true;
      }
      return (item.comments?.length || 0) > 0;
    };

    const assigned = workItems.filter(isUserAssigned);
    const created = workItems.filter((item) => item.authorId === userId);
    const subscribed = workItems.filter(isUserSubscribed);

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

    const resolveWorkItemStateGroup = (item: UserWorkItem): StateGroup => {
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

    // Group work items per project to compute project-level workload & progress
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

    // 1. Seed projectMap with all active projects
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

    const isEmpty =
      assigned.length === 0 &&
      created.length === 0 &&
      subscribed.length === 0 &&
      formattedActivities.length === 0;

    return {
      projectId,
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
      isEmpty,
      success: true,
    };
  }
}
