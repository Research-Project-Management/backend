import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Cycle } from '@prisma/client';
import {
  ICycleRepository,
  USER_MINIMAL_SELECT,
} from '../types/workflow-repository.interface';

@Injectable()
export class CycleRepository implements ICycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectCycles(projectId: string): Promise<Cycle[]> {
    return this.prisma.cycle.findMany({
      where: { projectId, deletedAt: null },
      include: {
        tasks: {
          where: { deletedAt: null },
          select: {
            id: true,
            title: true,
            columnId: true,
            priority: true,
            completed: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findCycleById(cycleId: string): Promise<Cycle | null> {
    return this.prisma.cycle.findFirst({
      where: { id: cycleId, deletedAt: null },
      include: {
        tasks: {
          where: { deletedAt: null },
          include: {
            assignee: { select: USER_MINIMAL_SELECT },
          },
        },
      },
    });
  }

  async createCycle(
    data: Prisma.CycleCreateInput | Prisma.CycleUncheckedCreateInput,
  ): Promise<Cycle> {
    return this.prisma.cycle.create({
      data: data as Prisma.CycleCreateInput,
      include: {
        tasks: true,
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
        tasks: true,
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

  async findCycleTasks(cycleId: string) {
    return this.prisma.task.findMany({
      where: { cycleId, deletedAt: null },
      select: {
        id: true,
        title: true,
        columnId: true,
        completed: true,
      },
    });
  }

  async transferIncompleteTasks(
    fromCycleId: string,
    targetCycleId: string | null,
  ) {
    return this.prisma.task.updateMany({
      where: {
        cycleId: fromCycleId,
        columnId: { not: 'done' },
        deletedAt: null,
      },
      data: {
        cycleId: targetCycleId,
      },
    });
  }
}
