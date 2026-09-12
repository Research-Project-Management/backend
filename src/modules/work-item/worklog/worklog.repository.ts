import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUuid } from '@/core/utils/tenant.util';
import { Prisma } from '@prisma/client';
import { USER_MINIMAL_SELECT } from '../core/types/work-item.types';
import { QueryWorklogDto } from './dto/query-worklog.dto';

@Injectable()
export class WorklogRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async resolveProjectId(projectIdOrIdentifier: string): Promise<string | null> {
    if (isUuid(projectIdOrIdentifier)) {
      return projectIdOrIdentifier;
    }
    const project = await this.prismaService.project.findFirst({
      where: {
        identifier: { equals: projectIdOrIdentifier, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true },
    });
    return project?.id || null;
  }

  async findTaskWithProject(taskId: string) {
    const where: Prisma.TaskWhereInput = isUuid(taskId)
      ? { id: taskId, deletedAt: null }
      : { identifier: taskId, deletedAt: null };

    return this.prismaService.task.findFirst({
      where,
      select: {
        id: true,
        identifier: true,
        title: true,
        projectId: true,
        timeSpent: true,
        project: {
          select: {
            id: true,
            identifier: true,
            workspaceId: true,
            name: true,
          },
        },
      },
    });
  }

  async createWorklog(data: Prisma.WorklogUncheckedCreateInput) {
    return this.prismaService.worklog.create({
      data,
      include: {
        user: { select: USER_MINIMAL_SELECT },
        task: { select: { id: true, identifier: true, title: true } },
      },
    });
  }

  async findWorklogById(id: string) {
    if (!isUuid(id)) return null;

    return this.prismaService.worklog.findUnique({
      where: { id },
      include: {
        user: { select: USER_MINIMAL_SELECT },
        task: {
          select: {
            id: true,
            identifier: true,
            title: true,
            projectId: true,
          },
        },
        project: {
          select: {
            id: true,
            identifier: true,
            workspaceId: true,
          },
        },
      },
    });
  }

  async findWorklogsByTaskId(taskId: string) {
    const canonicalTask = await this.findTaskWithProject(taskId);
    if (!canonicalTask) return [];

    return this.prismaService.worklog.findMany({
      where: { taskId: canonicalTask.id },
      include: {
        user: { select: USER_MINIMAL_SELECT },
      },
      orderBy: { date: 'desc' },
    });
  }

  async calculateTaskTotalTime(taskId: string): Promise<number> {
    const aggregateResult = await this.prismaService.worklog.aggregate({
      where: { taskId },
      _sum: { hours: true },
    });
    return Math.round((aggregateResult._sum.hours || 0) * 100) / 100;
  }

  async updateTaskTimeSpent(taskId: string, timeSpent: number) {
    return this.prismaService.task.update({
      where: { id: taskId },
      data: { timeSpent },
    });
  }

  async updateWorklog(
    id: string,
    data: Prisma.WorklogUpdateInput | Prisma.WorklogUncheckedUpdateInput,
  ) {
    return this.prismaService.worklog.update({
      where: { id },
      data,
      include: {
        user: { select: USER_MINIMAL_SELECT },
        task: { select: { id: true, identifier: true, title: true } },
      },
    });
  }

  async deleteWorklog(id: string) {
    return this.prismaService.worklog.delete({
      where: { id },
    });
  }

  async findProjectTimesheet(projectId: string, queryWorklogDto: QueryWorklogDto) {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) {
      return { worklogs: [], totalHours: 0, totalCount: 0, page: 1, limit: queryWorklogDto.limit || 50 };
    }

    const where: Prisma.WorklogWhereInput = {
      projectId: canonicalProjectId,
    };

    if (queryWorklogDto.userId && isUuid(queryWorklogDto.userId)) {
      where.userId = queryWorklogDto.userId;
    }

    if (queryWorklogDto.startDate || queryWorklogDto.endDate) {
      where.date = {};
      if (queryWorklogDto.startDate) where.date.gte = new Date(queryWorklogDto.startDate);
      if (queryWorklogDto.endDate) where.date.lte = new Date(queryWorklogDto.endDate);
    }

    const page = Math.max(1, queryWorklogDto.page || 1);
    const limit = Math.min(200, Math.max(1, queryWorklogDto.limit || 50));
    const skip = (page - 1) * limit;

    const [totalCount, aggregateHours, worklogs] = await Promise.all([
      this.prismaService.worklog.count({ where }),
      this.prismaService.worklog.aggregate({ where, _sum: { hours: true } }),
      this.prismaService.worklog.findMany({
        where,
        include: {
          user: { select: USER_MINIMAL_SELECT },
          task: { select: { id: true, identifier: true, title: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const totalHours = Math.round((aggregateHours._sum.hours || 0) * 100) / 100;

    return {
      worklogs,
      totalHours,
      totalCount,
      page,
      limit,
    };
  }

  async findWorkspaceTimesheet(workspaceId: string, queryWorklogDto: QueryWorklogDto) {
    const where: Prisma.WorklogWhereInput = {
      project: { workspaceId, deletedAt: null },
    };

    if (queryWorklogDto.projectId) {
      const canonicalProjectId = await this.resolveProjectId(queryWorklogDto.projectId);
      if (canonicalProjectId) {
        where.projectId = canonicalProjectId;
      }
    }

    if (queryWorklogDto.userId && isUuid(queryWorklogDto.userId)) {
      where.userId = queryWorklogDto.userId;
    }

    if (queryWorklogDto.startDate || queryWorklogDto.endDate) {
      where.date = {};
      if (queryWorklogDto.startDate) where.date.gte = new Date(queryWorklogDto.startDate);
      if (queryWorklogDto.endDate) where.date.lte = new Date(queryWorklogDto.endDate);
    }

    const page = Math.max(1, queryWorklogDto.page || 1);
    const limit = Math.min(200, Math.max(1, queryWorklogDto.limit || 50));
    const skip = (page - 1) * limit;

    const [totalCount, aggregateHours, worklogs] = await Promise.all([
      this.prismaService.worklog.count({ where }),
      this.prismaService.worklog.aggregate({ where, _sum: { hours: true } }),
      this.prismaService.worklog.findMany({
        where,
        include: {
          user: { select: USER_MINIMAL_SELECT },
          task: { select: { id: true, identifier: true, title: true } },
          project: { select: { id: true, identifier: true, name: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    const totalHours = Math.round((aggregateHours._sum.hours || 0) * 100) / 100;

    return {
      worklogs,
      totalHours,
      totalCount,
      page,
      limit,
    };
  }
}
