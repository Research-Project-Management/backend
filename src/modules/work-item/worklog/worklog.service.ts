import { Injectable, NotFoundException } from '@nestjs/common';
import { WorklogRepository } from './worklog.repository';
import {
  CreateWorklogDto,
  UpdateWorklogDto,
  QueryWorklogDto,
} from './dto/worklog.dto';
import {
  calculateTotalWorklogHours,
  normalizePagination,
} from './utils/worklog.util';
import { WorklogPaginationResult } from './types/worklog.types';

export { WorklogPaginationResult };

@Injectable()
export class WorklogService {
  constructor(private readonly worklogRepo: WorklogRepository) {}

  async getProjectWorklogs(projectId: string, query: QueryWorklogDto) {
    const { page, limit, offset } = normalizePagination(
      query.page,
      query.limit,
    );

    const startDate = query.startDate ? new Date(query.startDate) : undefined;
    const endDate = query.endDate ? new Date(query.endDate) : undefined;

    const { items, total } = await this.worklogRepo.findProjectWorklogs(
      projectId,
      {
        userId: query.userId,
        startDate,
        endDate,
        limit,
        offset,
      },
    );

    const totalHours = calculateTotalWorklogHours(items);

    return {
      items,
      total,
      totalHours,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async getWorkspaceWorklogs(workspaceId: string, query: QueryWorklogDto) {
    const { page, limit, offset } = normalizePagination(
      query.page,
      query.limit,
    );

    const startDate = query.startDate ? new Date(query.startDate) : undefined;
    const endDate = query.endDate ? new Date(query.endDate) : undefined;

    const { items, total } = await this.worklogRepo.findWorkspaceWorklogs(
      workspaceId,
      {
        userId: query.userId,
        startDate,
        endDate,
        limit,
        offset,
      },
    );

    const totalHours = calculateTotalWorklogHours(items);

    return {
      items,
      total,
      totalHours,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async createWorklog(
    projectId: string,
    userId: string,
    dto: CreateWorklogDto,
  ) {
    const workspaceId = await this.worklogRepo.resolveWorkspaceId(projectId);
    if (!workspaceId) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    const log = await this.worklogRepo.createWorklog({
      hours: dto.hours,
      description: dto.description || '',
      date: dto.date ? new Date(dto.date) : new Date(),
      user: { connect: { id: userId } },
      project: { connect: { id: projectId } },
      ...(dto.taskId ? { task: { connect: { id: dto.taskId } } } : {}),
    });

    return {
      success: true,
      data: log,
    };
  }

  async deleteWorklog(id: string) {
    await this.worklogRepo.deleteWorklog(id);
    return { success: true, message: 'Worklog deleted successfully' };
  }

  async updateWorklog(id: string, dto: UpdateWorklogDto) {
    const log = await this.worklogRepo.updateWorklog(id, {
      ...(dto.hours !== undefined && { hours: dto.hours }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.date !== undefined && { date: new Date(dto.date) }),
      ...(dto.taskId !== undefined && {
        task: dto.taskId
          ? { connect: { id: dto.taskId } }
          : { disconnect: true },
      }),
    });
    return { success: true, data: log };
  }
}
