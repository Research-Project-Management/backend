import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskRepository } from './task.repository';
import {
  CreateTaskDto,
  UpdateTaskDto,
  ReorderTaskDto,
  BulkUpdateTaskDto,
} from './dto/task.dto';
import {
  TaskPriority,
  TaskRecurrence,
  TaskReminder,
  Prisma,
  EntityType,
} from '@prisma/client';
import { parseTaskColumns } from '@/modules/project/types/project.types';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORKFLOW_REDIS_KEYS } from '../constants/redis-keys.constant';

const PRIORITY_MAP: Record<string, TaskPriority> = {
  none: TaskPriority.none,
  low: TaskPriority.low,
  medium: TaskPriority.medium,
  high: TaskPriority.high,
  urgent: TaskPriority.urgent,
};

const mapPriority = (priority?: string): TaskPriority => {
  return priority
    ? PRIORITY_MAP[priority] || TaskPriority.none
    : TaskPriority.none;
};

const RECURRENCE_MAP: Record<string, TaskRecurrence> = {
  none: TaskRecurrence.none,
  daily: TaskRecurrence.daily,
  'mon-fri': TaskRecurrence.mon_fri,
  mon_fri: TaskRecurrence.mon_fri,
  weekly: TaskRecurrence.weekly,
  'monthly-day': TaskRecurrence.monthly_day,
  monthly_day: TaskRecurrence.monthly_day,
  'monthly-week': TaskRecurrence.monthly_week,
  monthly_week: TaskRecurrence.monthly_week,
};

const mapRecurrence = (rec?: string): TaskRecurrence => {
  return rec && RECURRENCE_MAP[rec] ? RECURRENCE_MAP[rec] : TaskRecurrence.none;
};

const REMINDER_MAP: Record<string, TaskReminder> = {
  none: TaskReminder.none,
  'at-time': TaskReminder.at_time,
  at_time: TaskReminder.at_time,
  '5m': TaskReminder.m5,
  m5: TaskReminder.m5,
  '10m': TaskReminder.m10,
  m10: TaskReminder.m10,
  '15m': TaskReminder.m15,
  m15: TaskReminder.m15,
  '1h': TaskReminder.h1,
  h1: TaskReminder.h1,
  '2h': TaskReminder.h2,
  h2: TaskReminder.h2,
  '1day': TaskReminder.d1,
  d1: TaskReminder.d1,
  '2day': TaskReminder.d2,
  d2: TaskReminder.d2,
};

const mapReminder = (rem?: string): TaskReminder => {
  return rem && REMINDER_MAP[rem] ? REMINDER_MAP[rem] : TaskReminder.d1;
};

export interface TaskResponse {
  id: string;
  _id: string;
  identifier?: string | null;
  sequenceNumber?: number | null;
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
  timeSpent?: number | null;
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
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateTaskCache(projectId: string, taskId?: string) {
    if (!this.cache) return;
    await Promise.all([
      this.cache.del(WORKFLOW_REDIS_KEYS.projectTasks(projectId)),
      taskId
        ? this.cache.del(WORKFLOW_REDIS_KEYS.task(taskId))
        : Promise.resolve(),
      this.cache.del(`flux:proj:overview:${projectId}`),
    ]);
  }

  private formatTask(taskRecord: any): TaskResponse | null {
    if (!taskRecord) return null;

    const assignee = taskRecord.assignee
      ? {
          id: taskRecord.assignee.id,
          _id: taskRecord.assignee.id,
          name: taskRecord.assignee.name,
          email: taskRecord.assignee.email,
          avatar: taskRecord.assignee.avatar,
        }
      : null;

    const cycle = taskRecord.cycle
      ? {
          id: taskRecord.cycle.id,
          _id: taskRecord.cycle.id,
          name: taskRecord.cycle.name,
        }
      : taskRecord.cycleId || null;

    const isCompleted = taskRecord.columnId === 'done';

    const subtasks = Array.isArray(taskRecord.subtasks)
      ? taskRecord.subtasks.map((subtaskRecord: any) => ({
          ...subtaskRecord,
          id: subtaskRecord.id,
          _id: subtaskRecord.id,
          completed:
            subtaskRecord.columnId === 'done' ||
            Boolean(subtaskRecord.completed),
        }))
      : [];

    const subtaskCount = subtasks.length;
    const subtaskCompletedCount = subtasks.filter(
      (subtaskRecord: any) => subtaskRecord.completed,
    ).length;

    return {
      ...taskRecord,
      id: taskRecord.id,
      _id: taskRecord.id,
      identifier: taskRecord.identifier || null,
      sequenceNumber: taskRecord.sequenceNumber || null,
      description: taskRecord.content || '',
      content: taskRecord.content || '',
      assignee,
      cycle,
      completed: isCompleted,
      subtasks,
      subtaskCount,
      subtaskCompletedCount,
      createdAt: taskRecord.createdAt?.toISOString?.() || taskRecord.createdAt,
      updatedAt: taskRecord.updatedAt?.toISOString?.() || taskRecord.updatedAt,
      startDate:
        taskRecord.startDate?.toISOString?.() || taskRecord.startDate || null,
      dueDate:
        taskRecord.dueDate?.toISOString?.() || taskRecord.dueDate || null,
    };
  }

  async getWorkspaceTasks(workspaceId: string) {
    const taskRecords = await this.taskRepo.findWorkspaceTasks(workspaceId);
    const tasks = taskRecords
      .map((taskRecord) => this.formatTask(taskRecord))
      .filter((taskRecord): taskRecord is TaskResponse => taskRecord !== null);
    return { tasks };
  }

  async getProjectTasks(projectId: string, cycleId?: string) {
    const cacheKey = WORKFLOW_REDIS_KEYS.projectTasks(projectId);

    const fetchTasks = async () => {
      const taskRecords = await this.taskRepo.findProjectTasks(
        projectId,
        cycleId,
      );
      return taskRecords
        .map((taskRecord) => this.formatTask(taskRecord))
        .filter(
          (taskRecord): taskRecord is TaskResponse => taskRecord !== null,
        );
    };

    if (this.cache && !cycleId) {
      const tasks = await this.cache.wrap(cacheKey, fetchTasks, 1800);
      return { tasks };
    }

    const tasks = await fetchTasks();
    return { tasks };
  }

  async getTask(taskId: string) {
    const cacheKey = WORKFLOW_REDIS_KEYS.task(taskId);
    let task = this.cache ? await this.cache.get<any>(cacheKey) : null;

    if (!task) {
      const rawTask = await this.taskRepo.findTaskById(taskId);
      if (!rawTask) {
        throw new NotFoundException('Task not found');
      }
      task = this.formatTask(rawTask);
      if (this.cache) {
        await this.cache.set(cacheKey, task, 3600);
      }
    }

    return { task };
  }

  async createTask(projectId: string, authorId: string, dto: CreateTaskDto) {
    const rawProject = await this.taskRepo.findProjectWithColumns(projectId);
    if (!rawProject) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(rawProject.taskColumns);
    const targetColumn =
      dto.columnId || (columns.length > 0 ? columns[0].id : 'backlog');

    const columnCount = await this.taskRepo.countColumnTasks(
      projectId,
      targetColumn,
    );

    const { identifier, sequenceNumber } =
      await this.taskRepo.nextProjectTaskIdentifier(projectId);

    const task = await this.taskRepo.createTask({
      title: dto.title,
      content: dto.content || dto.description || '',
      columnId: targetColumn,
      rank: dto.rank ?? columnCount,
      priority: mapPriority(dto.priority),
      estimate: dto.estimate,
      identifier,
      sequenceNumber,
      labels: dto.labels || [],
      checklists: dto.checklists || [],
      attachments: dto.attachments || [],
      completed: targetColumn === 'done',
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      recurrence: mapRecurrence(dto.recurrence),
      reminder: mapReminder(dto.reminder),
      timeSpent: dto.timeSpent || 0,
      project: { connect: { id: projectId } },
      author: { connect: { id: authorId } },
      ...(dto.assigneeId
        ? { assignee: { connect: { id: dto.assigneeId } } }
        : {}),
      ...(dto.cycleId ? { cycle: { connect: { id: dto.cycleId } } } : {}),
      ...(dto.parentTaskId
        ? { parentTask: { connect: { id: dto.parentTaskId } } }
        : {}),
    });

    await this.invalidateTaskCache(projectId, task.id);

    this.eventEmitter?.emit(
      'task.created',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: task.id,
        verb: 'created',
        actorId: authorId,
        projectId,
      }),
    );

    return { task: this.formatTask(task) };
  }

  async updateTask(taskId: string, dto: UpdateTaskDto, userId?: string) {
    const existing = await this.taskRepo.findTaskById(taskId);
    if (!existing) {
      throw new NotFoundException('Task not found');
    }

    const updated = await this.taskRepo.updateTask(taskId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.description !== undefined && { content: dto.description }),
      ...(dto.columnId !== undefined && {
        columnId: dto.columnId,
        completed: dto.columnId === 'done',
      }),
      ...(dto.completed !== undefined && { completed: dto.completed }),
      ...(dto.rank !== undefined && { rank: dto.rank }),
      ...(dto.priority !== undefined && {
        priority: mapPriority(dto.priority),
      }),
      ...(dto.estimate !== undefined && { estimate: dto.estimate }),
      ...(dto.labels !== undefined && { labels: dto.labels }),
      ...(dto.checklists !== undefined && { checklists: dto.checklists }),
      ...(dto.attachments !== undefined && { attachments: dto.attachments }),
      ...(dto.recurrence !== undefined && {
        recurrence: mapRecurrence(dto.recurrence),
      }),
      ...(dto.reminder !== undefined && {
        reminder: mapReminder(dto.reminder),
      }),
      ...(dto.timeSpent !== undefined && { timeSpent: dto.timeSpent }),
      ...(dto.startDate !== undefined && {
        startDate: dto.startDate ? new Date(dto.startDate) : null,
      }),
      ...(dto.dueDate !== undefined && {
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      }),
      ...(dto.assigneeId !== undefined && {
        assignee: dto.assigneeId
          ? { connect: { id: dto.assigneeId } }
          : { disconnect: true },
      }),
      ...(dto.cycleId !== undefined && {
        cycle: dto.cycleId
          ? { connect: { id: dto.cycleId } }
          : { disconnect: true },
      }),
    });

    await this.invalidateTaskCache(existing.projectId, taskId);

    this.eventEmitter?.emit(
      'task.updated',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: taskId,
        verb: 'updated',
        actorId: userId || '',
        projectId: existing.projectId,
      }),
    );

    return { task: this.formatTask(updated) };
  }

  async deleteTask(taskId: string, userId?: string) {
    const existing = await this.taskRepo.findTaskById(taskId);
    if (!existing) {
      throw new NotFoundException('Task not found');
    }

    await this.taskRepo.softDeleteTask(taskId);
    await this.invalidateTaskCache(existing.projectId, taskId);

    this.eventEmitter?.emit(
      'task.deleted',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: taskId,
        verb: 'deleted',
        actorId: userId || '',
        projectId: existing.projectId,
      }),
    );

    return { message: 'Task soft-deleted successfully' };
  }

  async restoreTask(taskId: string) {
    const restored = await this.taskRepo.restoreTask(taskId);
    await this.invalidateTaskCache(restored.projectId, taskId);
    return {
      message: 'Task restored successfully',
      task: restored,
    };
  }

  async assignTask(taskId: string, assigneeId: string | null, userId?: string) {
    const existing = await this.taskRepo.findTaskById(taskId);
    if (!existing) {
      throw new NotFoundException('Task not found');
    }

    const updated = await this.taskRepo.assignTask(taskId, assigneeId);
    await this.invalidateTaskCache(existing.projectId, taskId);

    this.eventEmitter?.emit(
      'task.assigned',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: taskId,
        verb: 'assigned',
        actorId: userId || '',
        projectId: existing.projectId,
      }),
    );

    return { task: this.formatTask(updated) };
  }

  async reorderTask(taskId: string, dto: ReorderTaskDto) {
    const task = await this.taskRepo.findTaskById(taskId);
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const targetColumn = dto.columnId || task.columnId;
    const targetRank = dto.rank ?? 0;

    const columnTasks = await this.taskRepo.findColumnTasks(
      task.projectId,
      targetColumn,
    );

    const otherTasks = columnTasks.filter((taskItem) => taskItem.id !== taskId);
    otherTasks.splice(targetRank, 0, task);

    const updates = otherTasks.map((taskItem, index) => ({
      id: taskItem.id,
      rank: index,
      columnId: targetColumn,
      completed: targetColumn === 'done',
    }));

    await this.taskRepo.updateTasksRank(updates);
    await this.invalidateTaskCache(task.projectId, taskId);

    return { message: 'Task reordered successfully' };
  }

  async bulkUpdate(projectId: string, dto: BulkUpdateTaskDto, userId?: string) {
    const payload = dto.data || (dto as any);
    const data: any = {};

    if (payload.columnId !== undefined) {
      data.columnId = payload.columnId;
      data.completed = payload.columnId === 'done';
    }
    if (payload.assigneeId !== undefined) {
      data.assigneeId = payload.assigneeId;
    }
    if (payload.priority !== undefined) {
      data.priority = mapPriority(payload.priority);
    }
    if (payload.cycleId !== undefined) {
      data.cycleId = payload.cycleId;
    }

    const result = await this.taskRepo.bulkUpdateTasks(
      projectId,
      dto.taskIds,
      data,
    );

    await this.invalidateTaskCache(projectId);

    return {
      message: `${result.count} tasks updated successfully`,
      count: result.count,
    };
  }

  async duplicateTask(
    taskId: string,
    userId: string,
    targetProjectId?: string,
  ) {
    const source = await this.taskRepo.findTaskById(taskId);
    if (!source) {
      throw new NotFoundException('Task not found');
    }

    const projectId = targetProjectId || source.projectId;
    const { identifier, sequenceNumber } =
      await this.taskRepo.nextProjectTaskIdentifier(projectId);

    const columnCount = await this.taskRepo.countColumnTasks(
      projectId,
      source.columnId,
    );

    const cloned = await this.taskRepo.createTask({
      title: `${source.title} (Copy)`,
      content: source.content || source.description || '',
      columnId: source.columnId,
      rank: columnCount,
      priority: source.priority,
      estimate: source.estimate,
      identifier,
      sequenceNumber,
      labels: source.labels || [],
      checklists: (source.checklists as any) || [],
      attachments: (source.attachments as any) || [],
      completed: source.completed,
      startDate: source.startDate,
      dueDate: source.dueDate,
      project: { connect: { id: projectId } },
      author: { connect: { id: userId } },
      ...(source.assigneeId
        ? { assignee: { connect: { id: source.assigneeId } } }
        : {}),
      ...(source.cycleId ? { cycle: { connect: { id: source.cycleId } } } : {}),
      ...(source.parentTaskId
        ? { parentTask: { connect: { id: source.parentTaskId } } }
        : {}),
    });

    await this.invalidateTaskCache(projectId, cloned.id);

    return { task: this.formatTask(cloned) };
  }

  async addAttachment(
    taskId: string,
    attachment: {
      name?: string;
      url?: string;
      size?: number;
      mimeType?: string;
      [key: string]: unknown;
    },
  ) {
    const task = await this.taskRepo.findTaskById(taskId);
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const existingAttachments = Array.isArray(task.attachments)
      ? (task.attachments as any[])
      : [];
    const newAttachment = {
      id: crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).substring(2, 9),
      name: attachment.name || 'Attachment',
      url: attachment.url || '',
      size: attachment.size,
      mimeType: attachment.mimeType,
      createdAt: new Date().toISOString(),
      ...attachment,
    };

    const updatedAttachments = [...existingAttachments, newAttachment];
    const updated = await this.taskRepo.updateTask(taskId, {
      attachments: updatedAttachments,
    });

    await this.invalidateTaskCache(task.projectId, taskId);
    return { task: this.formatTask(updated), attachment: newAttachment };
  }

  async deleteAttachment(taskId: string, attachmentId: string) {
    const task = await this.taskRepo.findTaskById(taskId);
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const existingAttachments = Array.isArray(task.attachments)
      ? (task.attachments as any[])
      : [];
    const updatedAttachments = existingAttachments.filter(
      (att) => att.id !== attachmentId && att.attachmentId !== attachmentId,
    );

    const updated = await this.taskRepo.updateTask(taskId, {
      attachments: updatedAttachments,
    });

    await this.invalidateTaskCache(task.projectId, taskId);
    return {
      message: 'Attachment removed successfully',
      task: this.formatTask(updated),
    };
  }
}
