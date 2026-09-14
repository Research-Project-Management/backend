import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUUID } from 'class-validator';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
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
      this.prisma.page.count({
        where: { projectId: canonicalProjectId, deletedAt: null },
      }),
      this.prisma.file.count({
        where: {
          linkedToType: 'project',
          linkedToId: canonicalProjectId,
          trashedAt: null,
        },
      }),
      this.prisma.sticky.count({
        where: { projectId: canonicalProjectId, deletedAt: null },
      }),
      this.prisma.cycle.count({
        where: { projectId: canonicalProjectId, deletedAt: null },
      }),
      this.prisma.item.count({
        where: { projectId: canonicalProjectId, deletedAt: null },
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
      projectsCount,
      assignedWorkItemsCount,
      createdWorkItemsCount,
      pagesCount,
      stickiesCount,
      papersCount,
    ] = await Promise.all([
      this.prisma.projectMember.count({
        where: { userId },
      }),
      this.prisma.workItem.count({
        where: { assigneeId: userId, deletedAt: null },
      }),
      this.prisma.workItem.count({
        where: { authorId: userId, deletedAt: null },
      }),
      this.prisma.page.count({
        where: { authorId: userId, deletedAt: null },
      }),
      this.prisma.sticky.count({
        where: { userId, deletedAt: null },
      }),
      this.prisma.item.count({
        where: { userId, deletedAt: null },
      }),
    ]);

    return {
      projects: projectsCount,
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

    return this.prisma.workItem.findMany({
      where: { projectId: canonicalProjectId },
      select: {
        id: true,
        columnId: true,
        priority: true,
        completed: true,
        assigneeId: true,
        assignee: { select: USER_SELECT },
      },
    });
  }

  async findCycleWorkItems(cycleId: string) {
    if (!isUUID(cycleId)) return [];
    return this.prisma.workItem.findMany({
      where: { cycleId },
      select: {
        id: true,
        columnId: true,
        completed: true,
        priority: true,
      },
    });
  }

  /** Label distribution: count work items per label string in a project */
  async findProjectWorkItemsByLabel(projectId: string) {
    if (!isUUID(projectId)) return [];
    return this.prisma.workItem.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, labels: true },
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

  /** Cycle burndown: work items with dates for daily completion tracking */
  async findCycleWorkItemsWithDates(cycleId: string) {
    if (!isUUID(cycleId)) return [];
    return this.prisma.workItem.findMany({
      where: { cycleId, deletedAt: null },
      select: {
        id: true,
        completed: true,
        updatedAt: true,
        createdAt: true,
      },
    });
  }

  /** Cycle start and end dates for burndown axis */
  async findCycleById(cycleId: string) {
    if (!isUUID(cycleId)) return null;
    return this.prisma.cycle.findUnique({
      where: { id: cycleId },
      select: { id: true, startDate: true, endDate: true, name: true },
    });
  }
}
