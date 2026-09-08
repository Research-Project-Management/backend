import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Worklog } from '@prisma/client';
import { IWorklogRepository, WorklogQueryOptions } from './types/worklog.types';
import { USER_MINIMAL_SELECT } from '../types/work-item.types';

export { WorklogQueryOptions };

@Injectable()
export class WorklogRepository implements IWorklogRepository {
  constructor(private readonly prisma: PrismaService) {}

  private applyDateAndUserFilters(
    where: Prisma.WorklogWhereInput,
    options: WorklogQueryOptions,
  ): void {
    if (options.startDate || options.endDate) {
      where.date = {
        ...(options.startDate ? { gte: options.startDate } : {}),
        ...(options.endDate ? { lte: options.endDate } : {}),
      };
    }
    if (options.userId) {
      where.userId = options.userId;
    }
  }

  async findProjectWorklogs(
    projectId: string,
    options: WorklogQueryOptions,
  ): Promise<{ items: any[]; total: number }> {
    const where: Prisma.WorklogWhereInput = { projectId };
    this.applyDateAndUserFilters(where, options);

    const [items, total] = await Promise.all([
      this.prisma.worklog.findMany({
        where,
        orderBy: { date: 'desc' },
        take: options.limit,
        skip: options.offset,
        include: {
          user: { select: USER_MINIMAL_SELECT },
          task: { select: { id: true, title: true, identifier: true } },
        },
      }),
      this.prisma.worklog.count({ where }),
    ]);

    return { items, total };
  }

  async findWorkspaceWorklogs(
    workspaceId: string,
    options: WorklogQueryOptions,
  ): Promise<{ items: any[]; total: number }> {
    const where: Prisma.WorklogWhereInput = {
      project: { workspaceId, deletedAt: null },
    };
    this.applyDateAndUserFilters(where, options);

    const [items, total] = await Promise.all([
      this.prisma.worklog.findMany({
        where,
        orderBy: { date: 'desc' },
        take: options.limit,
        skip: options.offset,
        include: {
          user: { select: USER_MINIMAL_SELECT },
          project: { select: { id: true, name: true, identifier: true } },
          task: { select: { id: true, title: true, identifier: true } },
        },
      }),
      this.prisma.worklog.count({ where }),
    ]);

    return { items, total };
  }

  async findTaskWorklogs(taskId: string): Promise<Worklog[]> {
    return this.prisma.worklog.findMany({
      where: { taskId },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
      orderBy: { date: 'desc' },
    });
  }

  async createWorklog(
    data: Prisma.WorklogCreateInput | Prisma.WorklogUncheckedCreateInput,
  ): Promise<Worklog> {
    return this.prisma.$transaction(async (tx) => {
      const worklog = await tx.worklog.create({
        data: data as Prisma.WorklogCreateInput,
        include: {
          user: { select: USER_MINIMAL_SELECT },
        },
      });

      if (worklog.taskId) {
        await tx.task.update({
          where: { id: worklog.taskId },
          data: { timeSpent: { increment: worklog.hours } },
        });
      }

      return worklog;
    });
  }

  async deleteWorklog(id: string): Promise<Worklog> {
    return this.prisma.$transaction(async (tx) => {
      const worklog = await tx.worklog.delete({
        where: { id },
      });

      if (worklog.taskId) {
        await tx.task.update({
          where: { id: worklog.taskId },
          data: { timeSpent: { decrement: worklog.hours } },
        });
      }

      return worklog;
    });
  }

  async updateWorklog(
    id: string,
    data: Prisma.WorklogUpdateInput,
  ): Promise<Worklog> {
    return this.prisma.$transaction(async (tx) => {
      const oldWorklog = await tx.worklog.findUnique({
        where: { id },
      });
      if (!oldWorklog) {
        throw new NotFoundException('Worklog not found');
      }

      const updatedWorklog = await tx.worklog.update({
        where: { id },
        data,
        include: {
          user: { select: USER_MINIMAL_SELECT },
        },
      });

      const oldTaskId = oldWorklog.taskId;
      const newTaskId = updatedWorklog.taskId;
      const oldHours = oldWorklog.hours;
      const newHours = updatedWorklog.hours;

      if (oldTaskId === newTaskId) {
        if (oldTaskId && oldHours !== newHours) {
          const delta = newHours - oldHours;
          await tx.task.update({
            where: { id: oldTaskId },
            data: { timeSpent: { increment: delta } },
          });
        }
      } else {
        if (oldTaskId) {
          await tx.task.update({
            where: { id: oldTaskId },
            data: { timeSpent: { decrement: oldHours } },
          });
        }
        if (newTaskId) {
          await tx.task.update({
            where: { id: newTaskId },
            data: { timeSpent: { increment: newHours } },
          });
        }
      }

      return updatedWorklog;
    });
  }

  async resolveWorkspaceId(projectId: string): Promise<string | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { workspaceId: true },
    });
    return project?.workspaceId ?? null;
  }
}
