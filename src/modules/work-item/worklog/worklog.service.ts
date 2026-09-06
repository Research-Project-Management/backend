import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
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
import { PrismaService } from '@/core/database/prisma.service';

export { WorklogPaginationResult };

@Injectable()
export class WorklogService {
  constructor(
    private readonly worklogRepo: WorklogRepository,
    private readonly prisma: PrismaService,
  ) {}

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

  private async assertCanModifyWorklog(
    id: string,
    userId: string,
    action: string,
  ) {
    const log = await this.prisma.worklog.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            id: true,
            workspaceId: true,
          },
        },
      },
    });

    if (!log) {
      throw new NotFoundException('Worklog not found');
    }

    if (log.userId === userId) {
      return log;
    }

    const wsMember = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId: log.project.workspaceId, userId },
    });
    if (wsMember?.role === 'owner' || wsMember?.role === 'admin') {
      return log;
    }

    const projMember = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: log.projectId, userId },
      },
    });
    if (projMember?.role === 'admin') {
      return log;
    }

    throw new ForbiddenException(
      `You do not have permission to ${action} this worklog`,
    );
  }

  async deleteWorklog(id: string, userId: string) {
    await this.assertCanModifyWorklog(id, userId, 'delete');
    await this.worklogRepo.deleteWorklog(id);
    return { success: true, message: 'Worklog deleted successfully' };
  }

  async updateWorklog(id: string, userId: string, dto: UpdateWorklogDto) {
    await this.assertCanModifyWorklog(id, userId, 'update');
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
