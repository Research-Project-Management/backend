import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

const CYCLE_SELECT = {
  id: true,
  name: true,
} as const;

@Injectable()
export class TaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findWorkspaceTasks(workspaceId: string) {
    return this.prisma.task.findMany({
      where: {
        project: { workspaceId },
      },
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
      },
      orderBy: { rank: 'asc' },
    });
  }

  async findProjectTasks(projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId },
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
      },
      orderBy: { rank: 'asc' },
    });
  }

  async findTaskById(taskId: string) {
    return this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assignee: { select: USER_SELECT },
        cycle: true,
        subtasks: true,
      },
    });
  }

  async countColumnTasks(projectId: string, columnId: string): Promise<number> {
    return this.prisma.task.count({
      where: { projectId, columnId },
    });
  }

  async createTask(
    data: Prisma.TaskCreateInput | Prisma.TaskUncheckedCreateInput,
  ) {
    return this.prisma.task.create({
      data: data as Prisma.TaskCreateInput,
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
      },
    });
  }

  async updateTask(
    taskId: string,
    data: Prisma.TaskUpdateInput | Prisma.TaskUncheckedUpdateInput,
  ) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: data,
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
      },
    });
  }

  async deleteTask(taskId: string) {
    return this.prisma.task.delete({
      where: { id: taskId },
    });
  }

  async assignTask(taskId: string, assigneeId: string) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { assigneeId },
      include: {
        assignee: { select: USER_SELECT },
      },
    });
  }

  async findColumnTasks(projectId: string, columnId: string) {
    return this.prisma.task.findMany({
      where: { projectId, columnId },
      orderBy: { rank: 'asc' },
    });
  }

  async updateTasksRank(
    updates: Array<{ id: string; rank: number; columnId?: string }>,
  ) {
    return this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.task.update({
          where: { id: u.id },
          data: {
            rank: u.rank,
            ...(u.columnId && { columnId: u.columnId }),
          },
        }),
      ),
    );
  }

  async bulkUpdateTasks(
    projectId: string,
    taskIds: string[],
    data: Prisma.TaskUpdateManyMutationInput,
  ) {
    return this.prisma.task.updateMany({
      where: {
        id: { in: taskIds },
        projectId,
      },
      data,
    });
  }

  async getAuditLog(taskId: string) {
    return this.prisma.task.findUnique({
      where: { id: taskId },
      select: { createdAt: true, updatedAt: true, authorId: true },
    });
  }
}
