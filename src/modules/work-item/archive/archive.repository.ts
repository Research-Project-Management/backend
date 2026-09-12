import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { isUuid } from '@/core/utils/tenant.util';
import { Prisma } from '@prisma/client';
import { USER_MINIMAL_SELECT, CYCLE_SELECT } from '../core/types/work-item.types';

@Injectable()
export class ArchiveRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveProjectId(projectIdOrIdentifier: string): Promise<string | null> {
    if (isUuid(projectIdOrIdentifier)) {
      return projectIdOrIdentifier;
    }
    const project = await this.prisma.project.findFirst({
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

    return this.prisma.task.findFirst({
      where,
      include: {
        project: {
          select: {
            id: true,
            identifier: true,
            workspaceId: true,
            name: true,
          },
        },
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
      },
    });
  }

  async findTasksByIds(taskIds: string[]) {
    const validIds = taskIds.filter(isUuid);
    if (validIds.length === 0) return [];

    return this.prisma.task.findMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
      },
      include: {
        project: {
          select: {
            id: true,
            workspaceId: true,
          },
        },
      },
    });
  }

  async archiveTask(taskId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { archivedAt: new Date() },
      include: {
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }

  async restoreTask(taskId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { archivedAt: null },
      include: {
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }

  async bulkArchive(taskIds: string[]) {
    const validIds = taskIds.filter(isUuid);
    if (validIds.length === 0) return { count: 0 };

    return this.prisma.task.updateMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
      },
      data: { archivedAt: new Date() },
    });
  }

  async bulkRestore(taskIds: string[]) {
    const validIds = taskIds.filter(isUuid);
    if (validIds.length === 0) return { count: 0 };

    return this.prisma.task.updateMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
      },
      data: { archivedAt: null },
    });
  }

  async findArchivedTasks(
    projectId: string,
    options: { page?: number; limit?: number; search?: string },
  ) {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) {
      return { tasks: [], total: 0, page: 1, limit: options.limit || 50 };
    }

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(200, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.TaskWhereInput = {
      projectId: canonicalProjectId,
      archivedAt: { not: null },
      deletedAt: null,
    };

    if (options.search?.trim()) {
      const search = options.search.trim();
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { identifier: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, tasks] = await Promise.all([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        include: {
          assignee: { select: USER_MINIMAL_SELECT },
          cycle: { select: CYCLE_SELECT },
          project: { select: { id: true, identifier: true, workspaceId: true } },
        },
        orderBy: { archivedAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      tasks,
      total,
      page,
      limit,
    };
  }
}
