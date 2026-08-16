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

const SUBTASK_SELECT = {
  id: true,
  title: true,
  identifier: true,
  columnId: true,
  completed: true,
  rank: true,
  assigneeId: true,
  assignee: { select: USER_SELECT },
  dueDate: true,
} as const;

@Injectable()
export class TaskRepository {
  constructor(private readonly prisma: PrismaService) {}

  async nextProjectTaskIdentifier(projectId: string): Promise<string> {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { taskSequence: { increment: 1 } },
      select: { name: true, taskSequence: true },
    });

    const rawName = project.name || 'TASK';
    const normalized = rawName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim();

    const words = normalized.split(/\s+/).filter(Boolean);

    let prefix = 'TASK';
    if (words.length === 1 && words[0]) {
      prefix = words[0].slice(0, 4).toUpperCase();
    } else if (words.length > 1) {
      prefix = words
        .slice(0, 4)
        .map((w) => w[0])
        .join('')
        .toUpperCase();
    }

    return `${prefix}-${project.taskSequence}`;
  }

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: { OR: [{ id: workspaceIdOrSlug }, { url: workspaceIdOrSlug }] },
      select: { id: true },
    });
  }

  async findWorkspaceTasks(workspaceId: string) {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetId = ws?.id || workspaceId;
    return this.prisma.task.findMany({
      where: {
        project: { workspaceId: targetId },
      },
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
      },
      orderBy: { rank: 'asc' },
    });
  }

  async findProjectTasks(projectId: string, cycleId?: string) {
    return this.prisma.task.findMany({
      where: {
        projectId,
        ...(cycleId ? { cycleId } : {}),
      },
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
      },
      orderBy: { rank: 'asc' },
    });
  }

  async findProjectWithColumns(projectId: string) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, taskColumns: true },
    });
  }

  async findTaskById(taskId: string) {
    return this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
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
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
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
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
      },
    });
  }

  async deleteTask(taskId: string) {
    return this.prisma.task.delete({
      where: { id: taskId },
    });
  }

  async assignTask(taskId: string, assigneeId: string | null) {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { assigneeId },
      include: {
        assignee: { select: USER_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
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
    updates: Array<{
      id: string;
      rank: number;
      columnId?: string;
      completed?: boolean;
    }>,
  ) {
    return this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.task.update({
          where: { id: u.id },
          data: {
            rank: u.rank,
            ...(u.columnId && { columnId: u.columnId }),
            ...(u.completed !== undefined && { completed: u.completed }),
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
