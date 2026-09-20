import { Injectable } from '@nestjs/common';
import { CycleStatus } from '@prisma/client';
import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class OverviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getProjectMetadata(projectId: string) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
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
    const workItems = await this.prisma.workItem.findMany({
      where: {
        projectId,
        deletedAt: null,
      },
      select: {
        state: {
          select: {
            group: true,
          },
        },
      },
    });

    const counts: Record<string, number> = {
      backlog: 0,
      unstarted: 0,
      started: 0,
      completed: 0,
      cancelled: 0,
    };

    for (const item of workItems) {
      const group = item.state?.group || 'backlog';
      counts[group] = (counts[group] || 0) + 1;
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

  async getActiveCycle(projectId: string) {
    const now = new Date();
    const activeCycle = await this.prisma.cycle.findFirst({
      where: {
        projectId,
        deletedAt: null,
        OR: [
          { status: CycleStatus.active },
          {
            startDate: { lte: now },
            endDate: { gte: now },
          },
        ],
      },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        _count: {
          select: {
            workItems: {
              where: { deletedAt: null },
            },
          },
        },
      },
      orderBy: { startDate: 'desc' },
    });

    if (!activeCycle) {
      return null;
    }

    const completedIssues = await this.prisma.workItem.count({
      where: {
        cycleId: activeCycle.id,
        deletedAt: null,
        state: {
          group: 'completed',
        },
      },
    });

    return {
      activeCycle,
      completedIssues,
    };
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
}
