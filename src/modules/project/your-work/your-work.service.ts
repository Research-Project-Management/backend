import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { YourWorkRepository } from './your-work.repository';
import { ActivityService } from '@/modules/activity/activity.service';
import { YourWorkSummaryDto } from './dto/your-work.dto';
import { ActivityFeedItem } from './types/your-work.types';
import {
  aggregateYourWorkBreakdowns,
  formatYourWorkActivities,
  isUserAssignedToWorkItem,
  isUserSubscribedToWorkItem,
  normalizeYourWorkScopeProjectId,
} from './domain/your-work.domain';

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
    rawProjectId: string | undefined,
    userId: string,
  ): Promise<YourWorkSummaryDto> {
    const projectId = normalizeYourWorkScopeProjectId(rawProjectId, userId);

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

    const assigned = workItems.filter((item) =>
      isUserAssignedToWorkItem(item, userId),
    );
    const created = workItems.filter((item) => item.authorId === userId);
    const subscribed = workItems.filter((item) =>
      isUserSubscribedToWorkItem(item, userId),
    );

    const formattedActivities = formatYourWorkActivities(
      activityFeed.items as ActivityFeedItem[],
      userId,
    );

    const {
      stateGroupBreakdown,
      subscribedStateGroupBreakdown,
      priorityBreakdown,
      projectBreakdown,
    } = aggregateYourWorkBreakdowns({
      assigned,
      created,
      subscribed,
      projectList: projectList || [],
    });

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
