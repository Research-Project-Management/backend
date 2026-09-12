import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ExportFormat, ExportWorkItemsQueryDto } from './dto/export-query.dto';
import { exportTasksToCsv } from './utils/csv-exporter.util';

export interface ExportResult {
  data: string;
  contentType: string;
  filename: string;
}

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async exportProjectWorkItems(
    projectId: string,
    query: ExportWorkItemsQueryDto,
  ): Promise<ExportResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, identifier: true },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    const where: any = {
      projectId,
      deletedAt: null,
    };

    if (query.cycleId) {
      where.cycleId = query.cycleId;
    }
    if (query.columnId) {
      where.columnId = query.columnId;
    }
    if (query.priority) {
      where.priority = query.priority;
    }
    if (query.assigneeId) {
      where.assigneeId = query.assigneeId;
    }
    if (query.completed !== undefined) {
      where.completed = query.completed;
    }
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const tasks = await this.prisma.task.findMany({
      where,
      include: {
        author: {
          select: { id: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: [{ rank: 'asc' }, { createdAt: 'desc' }],
    });

    const timestamp = new Date().toISOString().slice(0, 10);
    const safeKey = (project.identifier || project.name || 'work-items')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-');

    if (query.format === ExportFormat.JSON) {
      return {
        data: JSON.stringify(tasks, null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `${safeKey}-export-${timestamp}.json`,
      };
    }

    const csvData = exportTasksToCsv(tasks);
    return {
      data: csvData,
      contentType: 'text/csv; charset=utf-8',
      filename: `${safeKey}-export-${timestamp}.csv`,
    };
  }

  async exportWorkspaceWorkItems(
    workspaceId: string,
    query: ExportWorkItemsQueryDto,
  ): Promise<ExportResult> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, slug: true },
    });

    if (!workspace) {
      throw new NotFoundException(`Workspace with ID ${workspaceId} not found`);
    }

    const where: any = {
      project: { workspaceId },
      deletedAt: null,
    };

    if (query.columnId) {
      where.columnId = query.columnId;
    }
    if (query.priority) {
      where.priority = query.priority;
    }
    if (query.assigneeId) {
      where.assigneeId = query.assigneeId;
    }
    if (query.completed !== undefined) {
      where.completed = query.completed;
    }
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const tasks = await this.prisma.task.findMany({
      where,
      include: {
        author: {
          select: { id: true, name: true, email: true },
        },
        assignee: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: [{ rank: 'asc' }, { createdAt: 'desc' }],
    });

    const timestamp = new Date().toISOString().slice(0, 10);
    const safeSlug = (workspace.slug || workspace.name || 'workspace')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-');

    if (query.format === ExportFormat.JSON) {
      return {
        data: JSON.stringify(tasks, null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `${safeSlug}-work-items-${timestamp}.json`,
      };
    }

    const csvData = exportTasksToCsv(tasks);
    return {
      data: csvData,
      contentType: 'text/csv; charset=utf-8',
      filename: `${safeSlug}-work-items-${timestamp}.csv`,
    };
  }
}
