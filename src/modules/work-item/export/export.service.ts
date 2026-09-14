import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ExportFormat, ExportWorkItemsQueryDto } from './dto/export-query.dto';
import { exportWorkItemsToCsv } from './utils/csv-exporter.util';

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
        { content: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const workItems = await this.prisma.workItem.findMany({
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
        data: JSON.stringify(workItems, null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `${safeKey}-export-${timestamp}.json`,
      };
    }

    const csvData = exportWorkItemsToCsv(workItems);
    return {
      data: csvData,
      contentType: 'text/csv; charset=utf-8',
      filename: `${safeKey}-export-${timestamp}.csv`,
    };
  }
}
