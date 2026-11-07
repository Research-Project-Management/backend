import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';

const USER_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async countProjectStats(projectId: string) {
    let canonicalProjectId = projectId;
    if (!isUUID(canonicalProjectId)) {
      const proj = await this.prisma.project
        .findFirst({
          where: {
            identifier: { equals: canonicalProjectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        })
        .catch(() => null);
      if (!proj) {
        return {
          members: 0,
          workItems: 0,
          pages: 0,
          files: 0,
          stickies: 0,
          cycles: 0,
          papers: 0,
        };
      }
      canonicalProjectId = proj.id;
    }

    const [
      membersCount,
      workItemsCount,
      pagesCount,
      filesCount,
      stickiesCount,
      cyclesCount,
      papersCount,
    ] = await Promise.all([
      this.prisma.projectMember.count({
        where: { projectId: canonicalProjectId },
      }),
      this.prisma.workItem.count({
        where: { projectId: canonicalProjectId, deletedAt: null },
      }),
      this.prisma.pageDoc.count({
        where: { spaceId: canonicalProjectId, deletedAt: null },
      }),
      this.prisma.storageFile.count({
        where: {
          spaceId: canonicalProjectId,
          deletedAt: null,
        },
      }),
      Promise.resolve(0),
      Promise.resolve(0),
      this.prisma.libraryItem.count({
        where: { spaceId: canonicalProjectId, deletedAt: null },
      }),
    ]);

    return {
      members: membersCount,
      workItems: workItemsCount,
      pages: pagesCount,
      files: filesCount,
      stickies: stickiesCount,
      cycles: cyclesCount,
      papers: papersCount,
    };
  }

  async countUserStats(userId: string) {
    if (!isUUID(userId)) {
      return {
        projects: 0,
        assignedWorkItems: 0,
        createdWorkItems: 0,
        pages: 0,
        stickies: 0,
        papers: 0,
      };
    }

    const [
      userProjects,
      assignedWorkItemsCount,
      createdWorkItemsCount,
      stickiesCount,
      papersCount,
    ] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { userId },
        select: { projectId: true },
      }),
      this.prisma.workItem.count({
        where: { assigneeId: userId, deletedAt: null },
      }),
      this.prisma.workItem.count({
        where: { createdById: userId, deletedAt: null },
      }),
      this.prisma.sticky.count({
        where: { userId, deletedAt: null },
      }),
      this.prisma.libraryItem.count({
        where: { spaceId: userId, deletedAt: null },
      }),
    ]);

    const projectIds = userProjects.map((p) => p.projectId);
    const spaceIds = Array.from(new Set([userId, ...projectIds]));
    const pagesCount = spaceIds.length
      ? await this.prisma.pageDoc.count({
          where: {
            spaceId: { in: spaceIds },
            deletedAt: null,
          },
        })
      : 0;

    return {
      projects: userProjects.length,
      assignedWorkItems: assignedWorkItemsCount,
      createdWorkItems: createdWorkItemsCount,
      pages: pagesCount,
      stickies: stickiesCount,
      papers: papersCount,
    };
  }

  async findProjectWorkItemsWithAssignees(projectId: string) {
    let canonicalProjectId = projectId;
    if (!isUUID(canonicalProjectId)) {
      const proj = await this.prisma.project
        .findFirst({
          where: {
            identifier: { equals: canonicalProjectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        })
        .catch(() => null);
      if (!proj) return [];
      canonicalProjectId = proj.id;
    }

    const items = await this.prisma.workItem.findMany({
      where: { projectId: canonicalProjectId, deletedAt: null },
      select: {
        id: true,
        stateId: true,
        priority: true,
        completed: true,
        assigneeId: true,
        assignee: { select: USER_SELECT },
      },
    });

    return items.map((item) => ({
      ...item,
      columnId: item.stateId,
      assignee: item.assignee
        ? {
            id: item.assignee.id,
            email: item.assignee.email,
            name: item.assignee.profile?.name ?? 'User',
            avatar: item.assignee.profile?.avatar ?? null,
          }
        : null,
    }));
  }

  /** Label distribution: count work items per label in a project */
  async findProjectWorkItemsByLabel(projectId: string) {
    if (!isUUID(projectId)) return [];
    return this.prisma.workItem.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true,
        labelAssignments: {
          select: {
            label: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
  }

  /** Time-series: work items created and completed per day within a date range */
  async findProjectWorkItemsTimeSeries(
    projectId: string,
    from: Date,
    to: Date,
  ) {
    if (!isUUID(projectId)) return [];
    return this.prisma.workItem.findMany({
      where: {
        projectId,
        deletedAt: null,
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        completed: true,
      },
    });
  }
}

