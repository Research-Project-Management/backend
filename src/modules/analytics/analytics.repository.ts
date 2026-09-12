import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async getCanonicalWorkspaceId(
    workspaceId: string,
  ): Promise<string | null> {
    if (!workspaceId) return null;
    if (isUuid(workspaceId)) return workspaceId;
    const ws = await this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceId),
      select: { id: true },
    });
    return ws?.id ?? null;
  }

  async countWorkspaceStats(workspaceId: string) {
    const canonicalId = await this.getCanonicalWorkspaceId(workspaceId);
    if (!canonicalId) {
      return {
        members: 0,
        projects: 0,
        tasks: 0,
        papers: 0,
        pages: 0,
        files: 0,
        stickies: 0,
      };
    }

    const [
      membersCount,
      projectsCount,
      tasksCount,
      papersCount,
      pagesCount,
      filesCount,
      stickiesCount,
    ] = await Promise.all([
      this.prisma.workspaceMember.count({
        where: { workspaceId: canonicalId },
      }),
      this.prisma.project.count({
        where: { workspaceId: canonicalId, isActive: true },
      }),
      this.prisma.task.count({
        where: { project: { workspaceId: canonicalId } },
      }),
      this.prisma.item.count({
        where: { workspaceId: canonicalId, deletedAt: null },
      }),
      this.prisma.page.count({
        where: {
          OR: [
            { workspaceId: canonicalId },
            { project: { workspaceId: canonicalId } },
          ],
          deletedAt: null,
        },
      }),
      this.prisma.file.count({
        where: { workspaceId: canonicalId, trashedAt: null },
      }),
      this.prisma.sticky.count({ where: { workspaceId: canonicalId } }),
    ]);

    return {
      members: membersCount,
      projects: projectsCount,
      tasks: tasksCount,
      papers: papersCount,
      pages: pagesCount,
      files: filesCount,
      stickies: stickiesCount,
    };
  }

  async findProjectTasksWithAssignees(projectId: string) {
    let canonicalProjectId = projectId;
    if (!isUuid(canonicalProjectId)) {
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

    return this.prisma.task.findMany({
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

  async findCycleTasks(cycleId: string) {
    if (!isUuid(cycleId)) return [];
    return this.prisma.task.findMany({
      where: { cycleId },
      select: {
        id: true,
        columnId: true,
        completed: true,
        priority: true,
      },
    });
  }

  /** Label distribution: count tasks per label string in a project */
  async findProjectTasksByLabel(projectId: string) {
    if (!isUuid(projectId)) return [];
    return this.prisma.task.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, labels: true },
    });
  }

  /** Time-series: tasks created and completed per day within a date range */
  async findProjectTasksTimeSeries(projectId: string, from: Date, to: Date) {
    if (!isUuid(projectId)) return [];
    return this.prisma.task.findMany({
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

  /** Cycle burndown: tasks with dates for daily completion tracking */
  async findCycleTasksWithDates(cycleId: string) {
    if (!isUuid(cycleId)) return [];
    return this.prisma.task.findMany({
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
    if (!isUuid(cycleId)) return null;
    return this.prisma.cycle.findUnique({
      where: { id: cycleId },
      select: { id: true, startDate: true, endDate: true, name: true },
    });
  }
}
