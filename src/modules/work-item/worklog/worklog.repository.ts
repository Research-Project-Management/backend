import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Worklog } from '@prisma/client';
import { IWorklogRepository, WorklogQueryOptions } from './types/worklog.types';
import { USER_MINIMAL_SELECT } from '../types/work-item.types';

export { WorklogQueryOptions };

@Injectable()
export class WorklogRepository implements IWorklogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectWorklogs(
    projectId: string,
    options: WorklogQueryOptions,
  ): Promise<{ items: any[]; total: number }> {
    const where: Prisma.WorklogWhereInput = { projectId };
    if (options.userId) where.userId = options.userId;
    if (options.startDate || options.endDate) {
      where.date = {};
      if (options.startDate) where.date.gte = options.startDate;
      if (options.endDate) where.date.lte = options.endDate;
    }

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
    if (options.userId) where.userId = options.userId;
    if (options.startDate || options.endDate) {
      where.date = {};
      if (options.startDate) where.date.gte = options.startDate;
      if (options.endDate) where.date.lte = options.endDate;
    }

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
    const worklog = await this.prisma.worklog.create({
      data: data as Prisma.WorklogCreateInput,
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
    });

    if (worklog.taskId) {
      await this.prisma.task.update({
        where: { id: worklog.taskId },
        data: { timeSpent: { increment: worklog.hours } },
      });
    }

    return worklog;
  }

  async deleteWorklog(id: string): Promise<Worklog> {
    const worklog = await this.prisma.worklog.delete({
      where: { id },
    });

    if (worklog.taskId) {
      await this.prisma.task.update({
        where: { id: worklog.taskId },
        data: { timeSpent: { decrement: worklog.hours } },
      });
    }

    return worklog;
  }

  async updateWorklog(
    id: string,
    data: Prisma.WorklogUpdateInput,
  ): Promise<Worklog> {
    return this.prisma.worklog.update({
      where: { id },
      data,
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
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
