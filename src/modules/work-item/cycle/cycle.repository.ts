import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Cycle, CycleStatus, WorkItem } from '@prisma/client';
import {
  ICycleRepository,
  CycleWorkItemItem,
  CycleWithWorkItems,
} from './types/cycle.types';
import { USER_MINIMAL_SELECT } from '../core/types/work-item.types';

@Injectable()
export class CycleRepository implements ICycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectCycles(projectId: string): Promise<Cycle[]> {
    return this.prisma.cycle.findMany({
      where: { projectId, deletedAt: null },
      include: {
        workItems: {
          where: { deletedAt: null },
          select: {
            id: true,
            title: true,
            columnId: true,
            priority: true,
            completed: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: [{ startDate: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findActiveCycle(
    projectId: string,
    excludeId?: string,
  ): Promise<Cycle | null> {
    return this.prisma.cycle.findFirst({
      where: {
        projectId,
        status: CycleStatus.active,
        deletedAt: null,
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
  }

  async findCycleById(cycleId: string): Promise<CycleWithWorkItems | null> {
    return this.prisma.cycle.findFirst({
      where: { id: cycleId, deletedAt: null },
      include: {
        workItems: {
          where: { deletedAt: null },
          include: {
            assignee: { select: USER_MINIMAL_SELECT },
          },
        },
      },
    });
  }

  async findOverlappingCycle(
    projectId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Cycle | null> {
    return this.prisma.cycle.findFirst({
      where: {
        projectId,
        deletedAt: null,
        status: { in: [CycleStatus.planned, CycleStatus.active] },
        startDate: { lte: end },
        endDate: { gte: start },
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
  }

  async createCycle(
    data: Prisma.CycleCreateInput | Prisma.CycleUncheckedCreateInput,
  ): Promise<Cycle> {
    return this.prisma.cycle.create({
      data: data as Prisma.CycleCreateInput,
      include: {
        workItems: true,
      },
    });
  }

  async updateCycle(
    cycleId: string,
    data: Prisma.CycleUpdateInput | Prisma.CycleUncheckedUpdateInput,
  ): Promise<Cycle> {
    return this.prisma.cycle.update({
      where: { id: cycleId },
      data: data,
      include: {
        workItems: true,
      },
    });
  }

  async softDeleteCycle(cycleId: string): Promise<Cycle> {
    return this.prisma.cycle.update({
      where: { id: cycleId },
      data: { deletedAt: new Date() },
    });
  }

  async restoreCycle(cycleId: string): Promise<Cycle> {
    return this.prisma.cycle.update({
      where: { id: cycleId },
      data: { deletedAt: null },
    });
  }

  async deleteCycle(cycleId: string): Promise<Cycle> {
    return this.prisma.cycle.delete({
      where: { id: cycleId },
    });
  }

  async findCycleWorkItems(cycleId: string): Promise<CycleWorkItemItem[]> {
    return this.prisma.workItem.findMany({
      where: { cycleId, deletedAt: null },
      select: {
        id: true,
        title: true,
        columnId: true,
        priority: true,
        completed: true,
      },
    });
  }

  async transferIncompleteWorkItems(
    fromCycleId: string,
    targetCycleId: string | null,
    incompleteWorkItemIds?: string[],
  ): Promise<Prisma.BatchPayload> {
    const whereClause: Prisma.WorkItemWhereInput = {
      cycleId: fromCycleId,
      deletedAt: null,
      ...(incompleteWorkItemIds && incompleteWorkItemIds.length > 0
        ? { id: { in: incompleteWorkItemIds } }
        : { completed: false, columnId: { not: 'done' } }),
    };

    return this.prisma.workItem.updateMany({
      where: whereClause,
      data: {
        cycleId: targetCycleId,
      },
    });
  }

  async findWorkItemById(workItemId: string) {
    return this.prisma.workItem.findUnique({
      where: { id: workItemId },
      select: { id: true, projectId: true },
    });
  }

  async addWorkItemToCycle(
    workItemId: string,
    cycleId: string,
  ): Promise<WorkItem> {
    return this.prisma.workItem.update({
      where: { id: workItemId },
      data: { cycleId },
    });
  }

  async removeWorkItemFromCycle(workItemId: string): Promise<WorkItem> {
    return this.prisma.workItem.update({
      where: { id: workItemId },
      data: { cycleId: null },
    });
  }

  async addWorkItemsBatch(
    workItemIds: string[],
    cycleId: string,
    projectId?: string,
  ): Promise<Prisma.BatchPayload> {
    return this.prisma.workItem.updateMany({
      where: {
        id: { in: workItemIds },
        deletedAt: null,
        ...(projectId ? { projectId } : {}),
      },
      data: { cycleId },
    });
  }

  async findCyclesEligibleForAutoComplete(
    now: Date = new Date(),
    projectId?: string,
  ): Promise<Cycle[]> {
    return this.prisma.cycle.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        status: CycleStatus.active,
        endDate: {
          lt: now,
        },
        deletedAt: null,
      },
      include: {
        workItems: {
          where: { deletedAt: null },
          select: {
            id: true,
            title: true,
            columnId: true,
            priority: true,
            completed: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
  }

  async findCyclesEligibleForAutoStart(
    now: Date = new Date(),
    projectId?: string,
  ): Promise<Cycle[]> {
    return this.prisma.cycle.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        status: CycleStatus.planned,
        startDate: {
          lte: now,
        },
        endDate: {
          gte: now,
        },
        deletedAt: null,
      },
      orderBy: {
        startDate: 'asc',
      },
    });
  }

  async hasActiveCycle(projectId: string): Promise<boolean> {
    const count = await this.prisma.cycle.count({
      where: {
        projectId,
        status: CycleStatus.active,
        deletedAt: null,
      },
    });
    return count > 0;
  }
}
