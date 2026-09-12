import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Task, ProjectMember, ProjectMemberRole } from '@prisma/client';
import {
  IAssignmentRepository,
  ProjectSettingsWithAssignee,
  ELIGIBLE_ASSIGNEE_ROLES,
} from './types/assignment.types';
import { isUuid } from '@/core/utils/tenant.util';

export type TaskWithProject = Task & {
  /** JSON array of all assignee user IDs (multi-assignee). Prisma v6 field. */
  assigneeIds?: unknown;
  project?: {
    id: string;
    workspaceId: string;
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

  async findTask(taskId: string): Promise<Task | null> {
    if (isUuid(taskId)) {
      return this.prismaService.task.findFirst({
        where: { id: taskId, deletedAt: null },
      });
    }
    return this.prismaService.task.findFirst({
      where: { identifier: taskId, deletedAt: null },
    });
  }

  async findTaskWithProject(taskId: string): Promise<TaskWithProject | null> {
    const whereClause = isUuid(taskId)
      ? { id: taskId, deletedAt: null }
      : { identifier: taskId, deletedAt: null };

    return this.prismaService.task.findFirst({
      where: whereClause,
      include: {
        project: {
          select: {
            id: true,
            workspaceId: true,
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

  async assignTask(taskId: string, assigneeId: string | null): Promise<Task> {
    return this.prismaService.task.update({
      where: { id: taskId },
      data: assigneeId
        ? { assignee: { connect: { id: assigneeId } } }
        : { assignee: { disconnect: true } },
    });
  }

  async bulkAssignTasks(
    projectId: string,
    taskIds: string[],
    assigneeId: string | null,
  ): Promise<number> {
    const result = await this.prismaService.task.updateMany({
      where: {
        id: { in: taskIds },
        projectId,
        deletedAt: null,
      },
      data: {
        assigneeId: assigneeId || null,
      },
    });
    return result.count;
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
   *
   * NOTE: `assigneeIds` is a new Json field — `as any` cast is intentional
   * until `prisma generate` updates the Prisma client types.
   */
  async setAssigneeIds(
    taskId: string,
    assigneeIds: string[],
    primaryAssigneeId: string | null,
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.prismaService.task.update as any)({
      where: { id: taskId },
      data: {
        assigneeIds,
        assigneeId: primaryAssigneeId,
      },
    });
  }

  /**
   * Resolve an ordered list of user IDs into user objects.
   */
  async findUsersByIds(
    userIds: string[],
  ): Promise<{ id: string; name: string | null; email: string | null; avatar: string | null }[]> {
    if (userIds.length === 0) return [];

    const users = await this.prismaService.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true, avatar: true },
    });

    // Preserve the original order (important: primary assignee is first)
    const userMap = new Map(users.map((userItem) => [userItem.id, userItem]));
    return userIds
      .map((id) => userMap.get(id))
      .filter((userItem): userItem is NonNullable<typeof userItem> => !!userItem);
  }
}
