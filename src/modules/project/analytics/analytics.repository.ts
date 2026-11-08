import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { isUUID } from 'class-validator';
import {
  RawAnalyticsWorkItem,
  RawProjectStateColumn,
} from './types/analytics.types';

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

  async resolveCanonicalProjectId(projectId: string): Promise<string | null> {
    if (!projectId) return null;
    if (isUUID(projectId)) return projectId;

    const proj = await this.prisma.project
      .findFirst({
        where: {
          identifier: { equals: projectId, mode: 'insensitive' },
          deletedAt: null,
        },
        select: { id: true },
      })
      .catch(() => null);

    return proj?.id ?? null;
  }

  async countProjectStats(projectId: string) {
    const canonicalProjectId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalProjectId) {
      return {
        members: 0,
        workItems: 0,
        pages: 0,
        files: 0,
        stickies: 0,
        papers: 0,
      };
    }

    const [
      membersCount,
      workItemsCount,
      pagesCount,
      filesCount,
      stickiesCount,
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

  async findProjectStates(
    projectId: string,
  ): Promise<RawProjectStateColumn[]> {
    const canonicalProjectId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalProjectId) return [];

    const states = await this.prisma.workItemState.findMany({
      where: { projectId: canonicalProjectId },
      select: {
        id: true,
        name: true,
        group: true,
        color: true,
        sequence: true,
      },
      orderBy: { sequence: 'asc' },
    });

    return states.map((s) => ({
      id: s.id,
      name: s.name,
      group: s.group,
      color: s.color || '#8A9093',
      sequence: s.sequence,
    }));
  }

  async findProjectWorkItemsWithAssignees(
    projectId: string,
  ): Promise<RawAnalyticsWorkItem[]> {
    const canonicalProjectId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalProjectId) return [];

    const items = await this.prisma.workItem.findMany({
      where: {
        projectId: canonicalProjectId,
        deletedAt: null,
        archivedAt: null,
      },
      select: {
        id: true,
        stateId: true,
        priority: true,
        completed: true,
        dueDate: true,
        assigneeId: true,
        state: {
          select: {
            id: true,
            name: true,
            group: true,
            color: true,
          },
        },
        assignee: { select: USER_SELECT },
        labelAssignments: {
          select: {
            label: {
              select: {
                id: true,
                name: true,
                color: true,
              },
            },
          },
        },
      },
    });

    return items.map((item) => ({
      id: item.id,
      stateId: item.stateId,
      columnId: item.stateId,
      stateGroup: item.state?.group ?? null,
      stateName: item.state?.name ?? null,
      stateColor: item.state?.color ?? null,
      priority: item.priority,
      completed: item.completed,
      dueDate: item.dueDate,
      assigneeId: item.assigneeId,
      assignee: item.assignee
        ? {
            id: item.assignee.id,
            email: item.assignee.email,
            name: item.assignee.profile?.name ?? 'User',
            avatar: item.assignee.profile?.avatar ?? null,
          }
        : null,
      labelAssignments: item.labelAssignments,
    }));
  }

  /** Label distribution: count work items per label in a project */
  async findProjectWorkItemsByLabel(projectId: string) {
    const canonicalProjectId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalProjectId) return [];

    return this.prisma.workItem.findMany({
      where: {
        projectId: canonicalProjectId,
        deletedAt: null,
        archivedAt: null,
      },
      select: {
        id: true,
        labelAssignments: {
          select: {
            label: {
              select: {
                id: true,
                name: true,
                color: true,
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
    const canonicalProjectId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalProjectId) return [];

    return this.prisma.workItem.findMany({
      where: {
        projectId: canonicalProjectId,
        deletedAt: null,
        OR: [
          { createdAt: { gte: from, lte: to } },
          { completed: true, updatedAt: { gte: from, lte: to } },
        ],
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
