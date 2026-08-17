import { Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskRepository } from './task.repository';
import {
  CreateTaskDto,
  UpdateTaskDto,
  ReorderTaskDto,
  BulkUpdateTaskDto,
} from './dto/task.dto';
import { TaskPriority, Prisma, EntityType } from '@prisma/client';
import { parseTaskColumns } from '@/core/types/json-fields.type';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

export interface TaskResponse {
  id: string;
  _id: string;
  identifier?: string | null;
  title: string;
  content: string;
  description: string;
  columnId: string;
  priority: TaskPriority;
  startDate?: string | null;
  dueDate?: string | null;
  labels: string[];
  checklists: any;
  completed: boolean;
  rank: number;
  projectId: string;
  authorId: string;
  assigneeId?: any;
  cycleId?: string | null;
  parentTaskId?: string | null;
  parentTask?: any;
  subtasks?: any[];
  subtaskCount?: number;
  subtaskCompletedCount?: number;
  assignee?: any;
  cycle?: any;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class TaskService {
  constructor(
    private readonly taskRepo: TaskRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  private formatTask(t: any): TaskResponse | null {
    if (!t) return null;

    const assignee = t.assignee
      ? {
          id: t.assignee.id,
          _id: t.assignee.id,
          name: t.assignee.name,
          email: t.assignee.email,
          avatar: t.assignee.avatar,
        }
      : null;

    const cycle = t.cycle
      ? {
          id: t.cycle.id,
          _id: t.cycle.id,
          name: t.cycle.name,
        }
      : t.cycleId || null;

    const isCompleted = t.columnId === 'done';

    const subtasks = Array.isArray(t.subtasks)
      ? t.subtasks.map((s: any) => ({
          ...s,
          id: s.id,
          _id: s.id,
          completed: s.columnId === 'done' || Boolean(s.completed),
        }))
      : [];

    const subtaskCount = subtasks.length;
    const subtaskCompletedCount = subtasks.filter((s: any) => s.completed).length;

    return {
      ...t,
      id: t.id,
      _id: t.id,
      identifier: t.identifier || null,
      description: t.content || '',
      content: t.content || '',
      assignee,
      assigneeId: assignee,
      cycle,
      cycleId: t.cycleId || null,
      parentTaskId: t.parentTaskId || null,
      parentTask: t.parentTask || null,
      subtasks,
      subtaskCount,
      subtaskCompletedCount,
      labels: Array.isArray(t.labels) ? t.labels : [],
      checklists: Array.isArray(t.checklists) ? t.checklists : [],
      completed: isCompleted,
      startDate: t.startDate ? new Date(t.startDate).toISOString() : null,
      dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : null,
      createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : new Date().toISOString(),
    };
  }

  async getWorkspaceTasks(workspaceId: string) {
    const tasks = await this.taskRepo.findWorkspaceTasks(workspaceId);
    const formatted = tasks.map((t) => this.formatTask(t));
    return { data: formatted, tasks: formatted };
  }

  async getTasks(projectId: string, cycleId?: string) {
    const [tasks, project] = await Promise.all([
      this.taskRepo.findProjectTasks(projectId, cycleId),
      this.taskRepo.findProjectWithColumns(projectId),
    ]);

    const formattedTasks = tasks.map((t) => this.formatTask(t));
    const columns = parseTaskColumns(project?.taskColumns);

    return {
      tasks: formattedTasks,
      columns,
      projectName: project?.name,
    };
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
    let cycleId = dto.cycleId || dto.cycle || null;
    const parentTaskId = dto.parentTaskId || dto.parentTask || null;
    const columnId = dto.columnId || 'backlog';
    const isCompleted = columnId === 'done';

    if (parentTaskId) {
      const parent = await this.taskRepo.findTaskById(parentTaskId);
      if (parent && !cycleId && parent.cycleId) {
        cycleId = parent.cycleId;
      }
    }

    const [count, identifier] = await Promise.all([
      this.taskRepo.countColumnTasks(projectId, columnId),
      this.taskRepo.nextProjectTaskIdentifier(projectId),
    ]);

    const task = await this.taskRepo.createTask({
      identifier,
      title: dto.title,
      content: dto.content || dto.description || '',
      columnId,
      completed: isCompleted,
      priority: dto.priority || TaskPriority.none,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      labels: dto.labels || [],
      checklists: (dto.checklists as Prisma.InputJsonValue) || [],
      rank: count,
      projectId,
      authorId: userId,
      assigneeId,
      cycleId,
      parentTaskId,
    });

    const formatted = this.formatTask(task);
    const workspaceId = (task as any).project?.workspaceId || '';

    this.eventEmitter?.emit(
      'task.created',
      new DomainActivityEvent({
        entityType: EntityType.task,
        entityId: task.id,
        verb: 'created',
        actorId: userId,
        projectId,
        workspaceId,
        newIdentifier: task.identifier || undefined,
      }),
    );

    return { task: formatted };
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

    if (parentTaskId !== undefined && parentTaskId !== null) {
      if (parentTaskId === taskId) {
        throw new BadRequestException('A task cannot be its own parent');
      }
      const parent = await this.taskRepo.findTaskById(parentTaskId);
      if (parent && parent.parentTaskId === taskId) {
        throw new BadRequestException('Circular parent-child relationship detected');
      }
    }

    const hasColumnChange = dto.columnId !== undefined;
    const isCompleted = hasColumnChange ? dto.columnId === 'done' : undefined;

    const task = await this.taskRepo.updateTask(taskId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.description !== undefined && { content: dto.description }),
      ...(dto.columnId !== undefined && { columnId: dto.columnId }),
      ...(isCompleted !== undefined && { completed: isCompleted }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.startDate !== undefined && {
        startDate: dto.startDate ? new Date(dto.startDate) : null,
      }),
      ...(dto.dueDate !== undefined && {
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      }),
      ...(dto.labels !== undefined && { labels: dto.labels }),
      ...(dto.checklists !== undefined && { checklists: dto.checklists as Prisma.InputJsonValue }),
      ...(dto.rank !== undefined && { rank: dto.rank }),
      ...(assigneeId !== undefined && { assigneeId: assigneeId || null }),
      ...(cycleId !== undefined && { cycleId: cycleId || null }),
      ...(parentTaskId !== undefined && {
        parentTaskId: parentTaskId || null,
      }),
    });

    const formatted = this.formatTask(task);
    const workspaceId = (task as any).project?.workspaceId || '';

    this.eventEmitter?.emit(
      'task.updated',
      new DomainActivityEvent({
        entityType: EntityType.task,
        entityId: task.id,
        verb: hasColumnChange ? 'moved' : 'updated',
        field: hasColumnChange ? 'columnId' : undefined,
        newValue: dto.columnId,
        actorId: task.authorId,
        projectId: task.projectId,
        workspaceId,
      }),
    );

    return { task: formatted };
  }

  async deleteTask(taskId: string) {
    const task = await this.taskRepo.findTaskById(taskId);
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    await this.taskRepo.deleteTask(taskId);

    const workspaceId = (task as any).project?.workspaceId || '';

    this.eventEmitter?.emit(
      'task.deleted',
      new DomainActivityEvent({
        entityType: EntityType.task,
        entityId: taskId,
        verb: 'deleted',
        actorId: task.authorId,
        projectId: task.projectId,
        workspaceId,
      }),
    );

    return { message: 'Task deleted successfully', success: true };
  }

  async assignTask(taskId: string, assigneeId: string | null) {
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

    const isDestCompleted = destinationColumnId === 'done';

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
              completed: isDestCompleted,
            })),
          ]);
        }
      }
    }

    return { success: true, ...dto };
  }

  async bulkUpdateTasks(projectId: string, dto: BulkUpdateTaskDto) {
    if (!dto.taskIds || dto.taskIds.length === 0) {
      return { success: true, count: 0 };
    }

    const payload: any = { ...dto.data };
    if (payload.columnId) {
      payload.completed = payload.columnId === 'done';
    }

    await this.taskRepo.bulkUpdateTasks(projectId, dto.taskIds, payload);
    return { success: true, count: dto.taskIds.length };
  }

  async duplicateTask(taskId: string, userId: string) {
    const original = await this.taskRepo.findTaskById(taskId);

    if (!original) {
      throw new NotFoundException('Task not found');
    }

    const identifier = await this.taskRepo.nextProjectTaskIdentifier(
      original.projectId,
    );

    const task = await this.taskRepo.createTask({
      identifier,
      title: `${original.title} (Copy)`,
      content: original.content,
      columnId: original.columnId,
      completed: original.columnId === 'done',
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
      parentTaskId: original.parentTaskId,
    });

    return { task: this.formatTask(task) };
  }
}
