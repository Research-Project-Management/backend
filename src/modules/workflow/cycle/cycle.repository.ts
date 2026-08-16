import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

@Injectable()
export class CycleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectCycles(projectId: string) {
    return this.prisma.cycle.findMany({
      where: { projectId },
      include: {
        tasks: {
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

  async findCycleById(cycleId: string) {
    return this.prisma.cycle.findUnique({
      where: { id: cycleId },
      include: {
        tasks: {
          include: {
            assignee: { select: USER_SELECT },
          },
        },
      },
    });
  }

  async createCycle(
    data: Prisma.CycleCreateInput | Prisma.CycleUncheckedCreateInput,
  ) {
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
  ) {
    return this.prisma.cycle.update({
      where: { id: cycleId },
      data: data,
      include: {
        tasks: true,
      },
    });
  }

  async deleteCycle(cycleId: string) {
    return this.prisma.cycle.delete({
      where: { id: cycleId },
    });
  }

  async findCycleTasks(cycleId: string) {
    return this.prisma.task.findMany({
      where: { cycleId },
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
      },
      data: {
        cycleId: targetCycleId,
      },
    });
  }
}
