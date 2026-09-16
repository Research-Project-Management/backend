import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';

@Injectable()
export class ProjectAnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getProjectWithMetadata(projectId: string) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        state: true,
        priority: true,
        startDate: true,
        targetDate: true,
        _count: {
          select: {
            members: true,
            cycles: true,
          },
        },
      },
    });
  }

  async getWorkItemsCountsByStateGroup(projectId: string): Promise<Record<string, number>> {
    // Query work items with their state group
    const rows = await this.prisma.workItem.findMany({
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

    for (const row of rows) {
      const group = row.state?.group || 'backlog';
      counts[group] = (counts[group] || 0) + 1;
    }

    return counts;
  }

  async getActiveCycle(projectId: string) {
    const now = new Date();
    const cycle = await this.prisma.cycle.findFirst({
      where: {
        projectId,
        startDate: { lte: now },
        endDate: { gte: now },
      },
      include: {
        workItems: {
          select: {
            state: {
              select: { group: true },
            },
          },
        },
      },
    });

    if (!cycle) return null;

    const total = cycle.workItems.length;
    const completed = cycle.workItems.filter(
      (w) => w.state?.group === 'completed',
    ).length;
    const progressPercentage = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      id: cycle.id,
      name: cycle.name,
      progressPercentage,
    };
  }

  async getWorkItemsDetailed(projectId: string) {
    return this.prisma.workItem.findMany({
      where: {
        projectId,
        deletedAt: null,
      },
      select: {
        id: true,
        priority: true,
        assigneeId: true,
        state: {
          select: {
            id: true,
            name: true,
            group: true,
            color: true,
          },
        },
      },
    });
  }

  async findProjectWorkItemsByLabel(projectId: string) {
    return this.prisma.workItem.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, labels: true },
    });
  }

  async findProjectWorkItemsTimeSeries(
    projectId: string,
    from: Date,
    to: Date,
  ) {
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
