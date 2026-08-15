import { Injectable, NotFoundException } from '@nestjs/common';
import { TaskRepository } from './task.repository';
import {
  CreateTaskDto,
  UpdateTaskDto,
  ReorderTaskDto,
  BulkUpdateTaskDto,
} from './dto/task.dto';
import { TaskPriority, Prisma } from '@prisma/client';

export type TaskWithRelations = Prisma.TaskGetPayload<{
  include: {
    assignee?: {
      select: { id: true; name: true; email: true; avatar: true };
    };
    cycle?: {
      select: { id: true; name: true };
    };
    author?: {
      select: { id: true; name: true; email: true; avatar: true };
    };
  };
}>;

export type FormattedTask<
  T extends {
    id: string;
    assignee?: { id: string } | null;
    assigneeId?: string | null;
    parentTaskId?: string | null;
    cycle?: { id: string } | null;
    cycleId?: string | null;
  },
> = T & {
  assignee?: { id: string } | null;
  parentTask?: string | null;
  cycle?: { id: string } | string | null;
};

@Injectable()
export class TaskService {
  constructor(private readonly taskRepo: TaskRepository) {}

  private formatTask<
    T extends {
      id: string;
      assignee?: { id: string } | null;
      assigneeId?: string | null;
      parentTaskId?: string | null;
      cycle?: { id: string } | null;
      cycleId?: string | null;
    },
  >(t: T): FormattedTask<T>;
  private formatTask(t: null | undefined): null;
  private formatTask<
    T extends {
      id: string;
      assignee?: { id: string } | null;
      assigneeId?: string | null;
      parentTaskId?: string | null;
      cycle?: { id: string } | null;
      cycleId?: string | null;
    },
  >(t: T | null | undefined): FormattedTask<T> | null;
  private formatTask<
    T extends {
      id: string;
      assignee?: { id: string } | null;
      assigneeId?: string | null;
      parentTaskId?: string | null;
      cycle?: { id: string } | null;
      cycleId?: string | null;
    },
  >(t: T | null | undefined): FormattedTask<T> | null {
    if (!t) return null;
    return {
      ...t,
      assignee: t.assignee
        ? t.assignee
        : t.assigneeId
          ? { id: t.assigneeId }
          : null,
      parentTask: t.parentTaskId,
      cycle: t.cycle ? t.cycle : t.cycleId,
    };
  }

  async getWorkspaceTasks(workspaceId: string) {
    const tasks = await this.taskRepo.findWorkspaceTasks(workspaceId);
    return { tasks: tasks.map((t) => this.formatTask(t)) };
  }

  async getTasks(projectId: string) {
    const tasks = await this.taskRepo.findProjectTasks(projectId);
    return { tasks: tasks.map((t) => this.formatTask(t)) };
  }

  async getTask(taskId: string) {
    const task = await this.taskRepo.findTaskById(taskId);

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    return { task: this.formatTask(task) };
  }

  async createTask(projectId: string, userId: string, dto: CreateTaskDto) {
    const assigneeId = dto.assigneeId || dto.assignee || null;
    const cycleId = dto.cycleId || dto.cycle || null;
    const parentTaskId = dto.parentTaskId || dto.parentTask || null;

    const count = await this.taskRepo.countColumnTasks(projectId, dto.columnId);

    const task = await this.taskRepo.createTask({
      title: dto.title,
      content: dto.content || dto.description || '',
      columnId: dto.columnId,
      priority: dto.priority || TaskPriority.none,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      labels: dto.labels || [],
      checklists: dto.checklists || [],
      rank: count,
      projectId,
      authorId: userId,
      assigneeId,
      cycleId,
      parentTaskId,
    });

    return { task: this.formatTask(task) };
  }

  async updateTask(taskId: string, dto: UpdateTaskDto) {
    const assigneeId =
      dto.assigneeId !== undefined
        ? dto.assigneeId
        : dto.assignee !== undefined
          ? dto.assignee
          : undefined;

    const cycleId =
      dto.cycleId !== undefined
        ? dto.cycleId
        : dto.cycle !== undefined
          ? dto.cycle
          : undefined;

    const parentTaskId =
      dto.parentTaskId !== undefined
        ? dto.parentTaskId
        : dto.parentTask !== undefined
          ? dto.parentTask
          : undefined;

    const task = await this.taskRepo.updateTask(taskId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.description !== undefined && { content: dto.description }),
      ...(dto.columnId !== undefined && { columnId: dto.columnId }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.startDate !== undefined && {
        startDate: dto.startDate ? new Date(dto.startDate) : null,
      }),
      ...(dto.dueDate !== undefined && {
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      }),
      ...(dto.labels !== undefined && { labels: dto.labels }),
      ...(dto.checklists !== undefined && { checklists: dto.checklists }),
      ...(dto.completed !== undefined && { completed: dto.completed }),
      ...(dto.rank !== undefined && { rank: dto.rank }),
      ...(assigneeId !== undefined && { assigneeId: assigneeId || null }),
      ...(cycleId !== undefined && { cycleId: cycleId || null }),
      ...(parentTaskId !== undefined && {
        parentTaskId: parentTaskId || null,
      }),
    });

    return { task: this.formatTask(task) };
  }

  async deleteTask(taskId: string) {
    await this.taskRepo.deleteTask(taskId);
    return { message: 'Task deleted successfully' };
  }

  async assignTask(taskId: string, assigneeId: string) {
    const task = await this.taskRepo.assignTask(taskId, assigneeId);
    return { task: this.formatTask(task) };
  }

  async reorderTasks(projectId: string, dto: ReorderTaskDto) {
    const {
      sourceColumnId,
      destinationColumnId,
      sourceIndex,
      destinationIndex,
    } = dto;

    // Fast-path: No-op if dropped in exact same column and position
    if (
      sourceColumnId === destinationColumnId &&
      sourceIndex === destinationIndex
    ) {
      return { success: true, ...dto };
    }

    const [sourceTasks, destTasks] = await Promise.all([
      this.taskRepo.findColumnTasks(projectId, sourceColumnId),
      sourceColumnId === destinationColumnId
        ? Promise.resolve([])
        : this.taskRepo.findColumnTasks(projectId, destinationColumnId),
    ]);

    if (sourceColumnId === destinationColumnId) {
      if (sourceTasks.length > 0 && sourceIndex < sourceTasks.length) {
        const [moved] = sourceTasks.splice(sourceIndex, 1);
        if (moved) {
          sourceTasks.splice(destinationIndex, 0, moved);
          await this.taskRepo.updateTasksRank(
            sourceTasks.map((t, idx) => ({ id: t.id, rank: idx })),
          );
        }
      }
    } else {
      if (sourceTasks.length > 0 && sourceIndex < sourceTasks.length) {
        const [moved] = sourceTasks.splice(sourceIndex, 1);
        if (moved) {
          destTasks.splice(destinationIndex, 0, moved);
          await this.taskRepo.updateTasksRank([
            ...sourceTasks.map((t, idx) => ({ id: t.id, rank: idx })),
            ...destTasks.map((t, idx) => ({
              id: t.id,
              rank: idx,
              columnId: destinationColumnId,
            })),
          ]);
        }
      }
    }

    return { success: true, ...dto };
  }

  async bulkUpdateTasks(projectId: string, dto: BulkUpdateTaskDto) {
    // Fast-path: Short-circuit if no tasks specified
    if (!dto.taskIds || dto.taskIds.length === 0) {
      return { success: true, count: 0 };
    }

    await this.taskRepo.bulkUpdateTasks(projectId, dto.taskIds, dto.data);
    return { success: true, count: dto.taskIds.length };
  }

  async duplicateTask(taskId: string, userId: string) {
    const original = await this.taskRepo.findTaskById(taskId);

    if (!original) {
      throw new NotFoundException('Task not found');
    }

    const task = await this.taskRepo.createTask({
      title: `${original.title} (Copy)`,
      content: original.content,
      columnId: original.columnId,
      priority: original.priority,
      startDate: original.startDate,
      dueDate: original.dueDate,
      labels: original.labels,
      checklists: original.checklists ? original.checklists : Prisma.JsonNull,
      rank: original.rank + 1,
      projectId: original.projectId,
      authorId: userId,
      assigneeId: original.assigneeId,
      cycleId: original.cycleId,
    });

    return { task: this.formatTask(task) };
  }

  async getAuditLog(taskId: string) {
    const task = await this.taskRepo.getAuditLog(taskId);
    return { activity: [task] };
  }
}
