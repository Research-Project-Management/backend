import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ProjectOverviewAssets } from './types/overview.types';

@Injectable()
export class OverviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getProjectMetadata(projectId: string) {
    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        name: true,
        identifier: true,
        description: true,
        avatar: true,
        coverImage: true,
        stateId: true,
        state: true,
        priority: true,
        startDate: true,
        targetDate: true,
        createdBy: {
          select: {
            id: true,
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
        members: {
          select: {
            userId: true,
            role: true,
            user: {
              select: {
                id: true,
                profile: {
                  select: {
                    name: true,
                    avatar: true,
                  },
                },
              },
            },
          },
        },
        _count: {
          select: {
            members: true,
          },
        },
      },
    });
  }

  async getWorkItemStateGroupCounts(
    projectId: string,
  ): Promise<Record<string, number>> {
    const [grouped, states] = await Promise.all([
      this.prisma.workItem.groupBy({
        by: ['stateId'],
        where: {
          projectId,
          deletedAt: null,
        },
        _count: {
          id: true,
        },
      }),
      this.prisma.workItemState.findMany({
        where: { projectId },
        select: { id: true, group: true },
      }),
    ]);

    const stateGroupMap = new Map<string, string>();
    for (const s of states) {
      stateGroupMap.set(s.id, s.group);
    }

    const counts: Record<string, number> = {
      backlog: 0,
      unstarted: 0,
      started: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const item of grouped) {
      const group =
        (item.stateId ? stateGroupMap.get(item.stateId) : null) || 'backlog';
      counts[group] = (counts[group] || 0) + item._count.id;
    }

    return counts;
  }

  async getOverdueCount(projectId: string): Promise<number> {
    const now = new Date();
    return this.prisma.workItem.count({
      where: {
        projectId,
        deletedAt: null,
        dueDate: { lt: now },
        state: {
          group: {
            notIn: ['completed', 'cancelled'],
          },
        },
      },
    });
  }

  async getRecentActivities(projectId: string, limit = 10) {
    return this.prisma.activityEvent.findMany({
      where: {
        projectId,
      },
      select: {
        id: true,
        verb: true,
        field: true,
        oldValue: true,
        newValue: true,
        oldIdentifier: true,
        newIdentifier: true,
        createdAt: true,
        actor: {
          select: {
            id: true,
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getLatestStatusUpdate(projectId: string) {
    return this.prisma.projectUpdate.findFirst({
      where: { projectId },
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getProjectAssets(projectId: string): Promise<ProjectOverviewAssets> {
    const space = await this.prisma.space.findFirst({
      where: { projectId },
      select: { id: true },
    });
    const spaceIds = Array.from(
      new Set([projectId, space?.id].filter(Boolean) as string[]),
    );
    if (spaceIds.length === 0) {
      return { pagesCount: 0, libraryCount: 0, filesCount: 0 };
    }
    const [pagesCount, libraryCount, filesCount] = await Promise.all([
      this.prisma.pageDoc.count({
        where: { spaceId: { in: spaceIds }, deletedAt: null },
      }),
      this.prisma.libraryItem.count({
        where: { spaceId: { in: spaceIds }, deletedAt: null },
      }),
      this.prisma.storageFile.count({
        where: {
          spaceId: { in: spaceIds },
          deletedAt: null,
          isFolder: false,
        },
      }),
    ]);
    return { pagesCount, libraryCount, filesCount };
  }
}
