import { Injectable } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { Prisma } from '@prisma/client';
import {
  USER_MINIMAL_SELECT,
  buildWorkItemIdOrIdentifierWhere,
} from '@/modules/work-item/common/types/shared.types';

@Injectable()
export class ArchiveRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveProjectId(
    projectIdOrIdentifier: string,
  ): Promise<string | null> {
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

  async findWorkItemWithProject(workItemId: string) {
    return this.prisma.workItem.findFirst({
      where: buildWorkItemIdOrIdentifierWhere(workItemId),
      include: {
        project: {
          select: {
            id: true,
            identifier: true,
            name: true,
          },
        },
        assignee: { select: USER_MINIMAL_SELECT },
      },
    });
  }

  async findWorkItemsByIds(workItemIds: string[]) {
    const validIds = workItemIds.filter(isUuid);
    if (validIds.length === 0) return [];

    return this.prisma.workItem.findMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
      },
      include: {
        project: {
          select: {
            id: true,
          },
        },
      },
    });
  }

  private setArchiveState(workItemId: string, archived: boolean) {
    return this.prisma.workItem.update({
      where: { id: workItemId },
      data: { archivedAt: archived ? new Date() : null },
      include: {
        project: { select: { id: true } },
      },
    });
  }

  private async bulkSetArchiveState(workItemIds: string[], archived: boolean) {
    const validIds = workItemIds.filter(isUuid);
    if (validIds.length === 0) return { count: 0 };

    return this.prisma.workItem.updateMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
      },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  async archiveWorkItem(workItemId: string) {
    return this.setArchiveState(workItemId, true);
  }

  async restoreWorkItem(workItemId: string) {
    return this.setArchiveState(workItemId, false);
  }

  async bulkArchive(workItemIds: string[]) {
    return this.bulkSetArchiveState(workItemIds, true);
  }

  async bulkRestore(workItemIds: string[]) {
    return this.bulkSetArchiveState(workItemIds, false);
  }

  async findArchivedWorkItems(
    projectId: string,
    options: { page?: number; limit?: number; search?: string },
  ) {
    const canonicalProjectId = await this.resolveProjectId(projectId);
    if (!canonicalProjectId) {
      return { workItems: [], total: 0, page: 1, limit: options.limit || 50 };
    }

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(200, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;

    const where: Prisma.WorkItemWhereInput = {
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

    const [total, workItems] = await Promise.all([
      this.prisma.workItem.count({ where }),
      this.prisma.workItem.findMany({
        where,
        include: {
          assignee: { select: USER_MINIMAL_SELECT },
          project: {
            select: { id: true, identifier: true },
          },
        },
        orderBy: { archivedAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      workItems,
      total,
      page,
      limit,
    };
  }
}
