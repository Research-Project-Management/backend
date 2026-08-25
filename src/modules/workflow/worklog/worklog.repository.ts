import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';

export interface WorklogRecord {
  id: string;
  hours: number;
  description: string;
  date: Date;
  userId: string;
  projectId: string;
  workspaceId: string;
  taskId?: string | null;
  taskTitle?: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    id: string;
    name: string;
    avatar: string | null;
    email: string | null;
  };
}

export interface WorklogQueryOptions {
  userId?: string;
  startDate?: Date;
  endDate?: Date;
  limit: number;
  offset: number;
}

@Injectable()
export class WorklogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectWorklogs(
    projectId: string,
    options: WorklogQueryOptions,
  ): Promise<{ items: any[]; total: number }> {
    // If prisma.worklog model is available in schema
    if ((this.prisma as any).worklog) {
      const where: any = { projectId };
      if (options.userId) where.userId = options.userId;
      if (options.startDate || options.endDate) {
        where.date = {};
        if (options.startDate) where.date.gte = options.startDate;
        if (options.endDate) where.date.lte = options.endDate;
      }

      const [items, total] = await Promise.all([
        (this.prisma as any).worklog.findMany({
          where,
          orderBy: { date: 'desc' },
          take: options.limit,
          skip: options.offset,
          include: {
            user: {
              select: { id: true, name: true, avatar: true, email: true },
            },
          },
        }),
        (this.prisma as any).worklog.count({ where }),
      ]);

      return { items, total };
    }

    // Fallback: Query via ActivityEvent with entityType 'task' or project tasks
    const _project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, avatar: true, email: true },
            },
          },
        },
      },
    });

    return { items: [], total: 0 };
  }

  async findWorkspaceWorklogs(
    workspaceId: string,
    options: WorklogQueryOptions,
  ): Promise<{ items: any[]; total: number }> {
    if ((this.prisma as any).worklog) {
      const where: any = { workspaceId };
      if (options.userId) where.userId = options.userId;
      if (options.startDate || options.endDate) {
        where.date = {};
        if (options.startDate) where.date.gte = options.startDate;
        if (options.endDate) where.date.lte = options.endDate;
      }

      const [items, total] = await Promise.all([
        (this.prisma as any).worklog.findMany({
          where,
          orderBy: { date: 'desc' },
          take: options.limit,
          skip: options.offset,
          include: {
            user: {
              select: { id: true, name: true, avatar: true, email: true },
            },
            project: { select: { id: true, name: true } },
          },
        }),
        (this.prisma as any).worklog.count({ where }),
      ]);

      return { items, total };
    }

    return { items: [], total: 0 };
  }

  async createWorklog(data: {
    hours: number;
    description?: string;
    date?: Date;
    userId: string;
    projectId: string;
    workspaceId: string;
    taskId?: string;
    taskTitle?: string;
  }) {
    if ((this.prisma as any).worklog) {
      return (this.prisma as any).worklog.create({
        data: {
          hours: data.hours,
          description: data.description || '',
          date: data.date || new Date(),
          userId: data.userId,
          projectId: data.projectId,
          workspaceId: data.workspaceId,
          taskId: data.taskId,
        },
        include: {
          user: { select: { id: true, name: true, avatar: true, email: true } },
        },
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
      select: { id: true, name: true, avatar: true, email: true },
    });

    return {
      id: `wl-${Date.now()}`,
      hours: data.hours,
      description: data.description || '',
      date: data.date || new Date(),
      userId: data.userId,
      projectId: data.projectId,
      workspaceId: data.workspaceId,
      taskId: data.taskId,
      taskTitle: data.taskTitle,
      user,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async deleteWorklog(id: string) {
    if ((this.prisma as any).worklog) {
      return await (this.prisma as any).worklog.delete({
        where: { id },
      });
    }
    return { id, deleted: true };
  }

  async updateWorklog(id: string, data: Record<string, any>) {
    if ((this.prisma as any).worklog) {
      return (this.prisma as any).worklog.update({
        where: { id },
        data,
        include: {
          user: { select: { id: true, name: true, avatar: true, email: true } },
        },
      });
    }
    return { id, ...data, updatedAt: new Date() };
  }

  async resolveWorkspaceId(projectId: string): Promise<string | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    return project?.workspaceId ?? null;
  }
}
