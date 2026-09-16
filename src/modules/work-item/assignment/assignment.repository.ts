import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { WorkItem, ProjectMember } from '@prisma/client';
import {
  IAssignmentRepository,
  ProjectSettingsWithAssignee,
  ELIGIBLE_ASSIGNEE_ROLES,
  ProjectMemberRole,
} from './types/assignment.types';
import { isUuid } from '@/core/utils/uuid.util';

export type WorkItemWithProject = WorkItem & {
  /** JSON array of all assignee user IDs (multi-assignee). Prisma v6 field. */
  assigneeIds?: unknown;
  project?: {
    id: string;
    settings?: unknown;
  } | null;
  assignee?: {
    id: string;
    name: string;
    email: string | null;
    avatar: string | null;
  } | null;
};

@Injectable()
export class AssignmentRepository implements IAssignmentRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findWorkItem(workItemId: string): Promise<WorkItem | null> {
    if (isUuid(workItemId)) {
      return this.prismaService.workItem.findFirst({
        where: { id: workItemId, deletedAt: null },
      });
    }
    return this.prismaService.workItem.findFirst({
      where: { identifier: workItemId, deletedAt: null },
    });
  }

  async findWorkItemWithProject(
    workItemId: string,
  ): Promise<WorkItemWithProject | null> {
    const whereClause = isUuid(workItemId)
      ? { id: workItemId, deletedAt: null }
      : { identifier: workItemId, deletedAt: null };

    return this.prismaService.workItem.findFirst({
      where: whereClause,
      include: {
        project: {
          select: {
            id: true,
            settings: true,
          },
        },
        assignee: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findProjectMember(
    projectId: string,
    userId: string,
  ): Promise<ProjectMember | null> {
    return this.prismaService.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findEligibleAssignees(projectId: string): Promise<
    (ProjectMember & {
      user: {
        id: string;
        name: string;
        email: string | null;
        avatar: string | null;
      };
    })[]
  > {
    return this.prismaService.projectMember.findMany({
      where: {
        projectId,
        role: {
          in: [...ELIGIBLE_ASSIGNEE_ROLES],
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
      orderBy: {
        joinedAt: 'asc',
      },
    });
  }

  async assignWorkItem(
    workItemId: string,
    assigneeId: string | null,
  ): Promise<WorkItem> {
    return this.prismaService.$transaction(async (tx) => {
      const updated = await tx.workItem.update({
        where: { id: workItemId },
        data: assigneeId
          ? {
              assignee: { connect: { id: assigneeId } },
              assigneeIds: [assigneeId],
            }
          : {
              assignee: { disconnect: true },
              assigneeIds: [],
            },
      });

      await tx.workItemAssignee.deleteMany({
        where: { workItemId },
      });

      if (assigneeId) {
        await tx.workItemAssignee.create({
          data: {
            workItemId,
            userId: assigneeId,
            isPrimary: true,
          },
        });
      }

      return updated;
    });
  }

  async bulkAssignWorkItems(
    projectId: string,
    workItemIds: string[],
    assigneeId: string | null,
  ): Promise<number> {
    return this.prismaService.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: {
          id: { in: workItemIds },
          projectId,
          deletedAt: null,
        },
        data: {
          assigneeId: assigneeId || null,
          assigneeIds: assigneeId ? [assigneeId] : [],
        },
      });

      await tx.workItemAssignee.deleteMany({
        where: { workItemId: { in: workItemIds } },
      });

      if (assigneeId) {
        await tx.workItemAssignee.createMany({
          data: workItemIds.map((workItemId) => ({
            workItemId,
            userId: assigneeId,
            isPrimary: true,
          })),
          skipDuplicates: true,
        });
      }

      return result.count;
    });
  }

  async getProjectSettings(
    projectId: string,
  ): Promise<ProjectSettingsWithAssignee | null> {
    const project = await this.prismaService.project.findUnique({
      where: { id: projectId },
      select: { settings: true },
    });
    if (!project || !project.settings || typeof project.settings !== 'object') {
      return null;
    }
    return project.settings as ProjectSettingsWithAssignee;
  }

  /**
   * Persist the full assignee list and sync the primary assigneeId.
   */
  async setAssigneeIds(
    workItemId: string,
    assigneeIds: string[],
    primaryAssigneeId: string | null,
  ): Promise<void> {
    await this.prismaService.$transaction([
      this.prismaService.workItem.update({
        where: { id: workItemId },
        data: {
          assigneeIds,
          assigneeId: primaryAssigneeId,
        },
      }),
      this.prismaService.workItemAssignee.deleteMany({
        where: { workItemId },
      }),
      ...(assigneeIds.length > 0
        ? [
            this.prismaService.workItemAssignee.createMany({
              data: assigneeIds.map((userId) => ({
                workItemId,
                userId,
                isPrimary: userId === primaryAssigneeId,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);
  }

  /**
   * Persist the subscriber IDs list.
   */
  async setSubscriberIds(
    workItemId: string,
    subscriberIds: string[],
  ): Promise<void> {
    await this.prismaService.workItem.update({
      where: { id: workItemId },
      data: {
        subscriberIds: subscriberIds as any,
      },
    });
  }

  /**
   * Resolve an ordered list of user IDs into user objects.
   */
  async findUsersByIds(userIds: string[]): Promise<
    {
      id: string;
      name: string | null;
      email: string | null;
      avatar: string | null;
    }[]
  > {
    if (userIds.length === 0) return [];

    const users = await this.prismaService.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true, avatar: true },
    });

    // Preserve the original order (important: primary assignee is first)
    const userMap = new Map(users.map((userItem) => [userItem.id, userItem]));
    return userIds
      .map((id) => userMap.get(id))
      .filter(
        (userItem): userItem is NonNullable<typeof userItem> => !!userItem,
      );
  }
}
