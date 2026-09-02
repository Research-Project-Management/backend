import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkItemRepository } from './work-item.repository';
import {
  CreateWorkItemDto,
  UpdateWorkItemDto,
  ReorderWorkItemDto,
  BulkUpdateWorkItemDto,
  QueryWorkItemDto,
} from './dto/work-item.dto';
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
import { WORK_ITEM_REDIS_KEYS } from './constants/redis-keys.constant';
import {
  mapPriority,
  mapRecurrence,
  mapReminder,
  formatWorkItem,
} from './utils/work-item.util';
import {
  WorkItemResponse,
  TaskResponse,
  WorkItemFilterOptions,
} from './types/work-item.types';

export { WorkItemResponse, TaskResponse };

@Injectable()
export class WorkItemService {
  constructor(
    private readonly workItemRepo: WorkItemRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private isDoneColumn(col?: string | null): boolean {
    if (!col) return false;
    const lower = col.toLowerCase();
    return (
      lower === 'done' ||
      lower === 'completed' ||
      lower.includes('done') ||
      lower.includes('complete')
    );
  }

  private async invalidateTaskCache(
    projectId: string,
    taskId?: string,
    cycleId?: string | null,
  ) {
    if (!this.cache) return;
    const deletions: Promise<any>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)),
      this.cache.del(`flux:proj:overview:${projectId}`),
    ];
    if (taskId) {
      deletions.push(this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)));
    }
    if (cycleId) {
      deletions.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.cycle(cycleId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectCycles(projectId)),
      );
    }
    await Promise.all(deletions);
  }

  private formatTask(taskRecord: any): WorkItemResponse | null {
    return formatWorkItem(taskRecord);
  }

  async getWorkspaceTasks(workspaceId: string) {
    const taskRecords = await this.workItemRepo.findWorkspaceTasks(workspaceId);
    const tasks = taskRecords
      .map((taskRecord) => this.formatTask(taskRecord))
      .filter(
        (taskRecord): taskRecord is WorkItemResponse => taskRecord !== null,
      );
    return { tasks };
  }

  async getProjectTasks(projectId: string, filter?: string | QueryWorkItemDto) {
    const isSimpleCycle = typeof filter === 'string';
    const isUnfiltered =
      !filter ||
      (typeof filter === 'object' && Object.keys(filter).length === 0);

    const cacheKey = isSimpleCycle
      ? `${WORK_ITEM_REDIS_KEYS.projectTasks(projectId)}:cycle:${filter}`
      : WORK_ITEM_REDIS_KEYS.projectTasks(projectId);

    const fetchTasks = async () => {
      const filterOptions: WorkItemFilterOptions | string | undefined =
        typeof filter === 'string'
          ? filter
          : filter
            ? {
                cycleId: filter.cycleId || filter.cycle,
                columnId: filter.columnId,
                priority: filter.priority,
                assigneeId: filter.assigneeId,
                parentTaskId: filter.parentTaskId,
                completed: filter.completed,
                search: filter.search,
                limit: filter.limit,
                offset:
                  filter.page && filter.limit
                    ? (filter.page - 1) * filter.limit
                    : undefined,
              }
            : undefined;

      const taskRecords = await this.workItemRepo.findProjectTasks(
        projectId,
        filterOptions,
      );
      return taskRecords
        .map((taskRecord) => this.formatTask(taskRecord))
        .filter(
          (taskRecord): taskRecord is WorkItemResponse => taskRecord !== null,
        );
    };

    if (this.cache && (isUnfiltered || isSimpleCycle)) {
      const tasks = await this.cache.wrap(cacheKey, fetchTasks, 1800);
      return { tasks };
    }

    const tasks = await fetchTasks();
    return { tasks };
  }

  async getTask(taskId: string) {
    const cacheKey = WORK_ITEM_REDIS_KEYS.task(taskId);
    let task = this.cache ? await this.cache.get<any>(cacheKey) : null;

    if (!task) {
      const rawTask = await this.workItemRepo.findTaskById(taskId);
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

  async createTask(
    projectId: string,
    authorId: string,
    dto: CreateWorkItemDto,
  ) {
    const rawProject =
      await this.workItemRepo.findProjectWithColumns(projectId);
    if (!rawProject) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(rawProject.taskColumns);
    const targetColumn =
      dto.columnId || (columns.length > 0 ? columns[0].id : 'backlog');

    const columnCount = await this.workItemRepo.countColumnTasks(
      projectId,
      targetColumn,
    );

    const { identifier, sequenceNumber } =
      await this.workItemRepo.nextProjectTaskIdentifier(projectId);

    const task = await this.workItemRepo.createTask({
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
      completed: dto.completed !== undefined ? dto.completed : targetColumn === 'done',
      issueType: dto.issueType || 'task',
      storyPoints: dto.storyPoints ?? null,
      relations: dto.relations || [],
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

    await this.invalidateTaskCache(projectId, task.id, dto.cycleId);

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

  async updateTask(taskId: string, dto: UpdateWorkItemDto, userId?: string) {
    const existing = await this.workItemRepo.findTaskById(taskId);
    if (!existing) {
      throw new NotFoundException('Task not found');
    }

    const updated = await this.workItemRepo.updateTask(taskId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.description !== undefined && { content: dto.description }),
      ...(dto.columnId !== undefined && {
        columnId: dto.columnId,
        completed: this.isDoneColumn(dto.columnId),
      }),
      ...(dto.completed !== undefined && { completed: dto.completed }),
      ...(dto.issueType !== undefined && { issueType: dto.issueType }),
      ...(dto.storyPoints !== undefined && { storyPoints: dto.storyPoints }),
      ...(dto.relations !== undefined && { relations: dto.relations }),
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

    await this.invalidateTaskCache(
      existing.projectId,
      taskId,
      dto.cycleId || existing.cycleId,
    );

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
    const existing = await this.workItemRepo.findTaskById(taskId);
    if (!existing) {
      throw new NotFoundException('Task not found');
    }

    await this.workItemRepo.softDeleteTask(taskId);
    await this.invalidateTaskCache(
      existing.projectId,
      taskId,
      existing.cycleId,
    );

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

  async restoreTask(taskId: string, userId?: string) {
    const restored = await this.workItemRepo.restoreTask(taskId);
    await this.invalidateTaskCache(
      restored.projectId,
      taskId,
      restored.cycleId,
    );

    this.eventEmitter?.emit(
      'task.updated',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: taskId,
        verb: 'updated',
        actorId: userId || '',
        projectId: restored.projectId,
      }),
    );

    return {
      message: 'Task restored successfully',
      task: this.formatTask(restored),
    };
  }

  async assignTask(taskId: string, assigneeId: string | null, userId?: string) {
    const existing = await this.workItemRepo.findTaskById(taskId);
    if (!existing) {
      throw new NotFoundException('Task not found');
    }

    const updated = await this.workItemRepo.assignTask(taskId, assigneeId);
    await this.invalidateTaskCache(
      existing.projectId,
      taskId,
      existing.cycleId,
    );

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

  async reorderTask(taskId: string, dto: ReorderWorkItemDto) {
    const task = await this.workItemRepo.findTaskById(taskId);
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const targetColumn = dto.columnId || task.columnId;
    const targetRank = dto.rank ?? 0;

    const columnTasks = await this.workItemRepo.findColumnTasks(
      task.projectId,
      targetColumn,
    );

    const otherTasks = columnTasks.filter((taskItem) => taskItem.id !== taskId);
    otherTasks.splice(targetRank, 0, task);

    const updates = otherTasks.map((taskItem, index) => ({
      id: taskItem.id,
      rank: index,
      columnId: targetColumn,
      completed: this.isDoneColumn(targetColumn),
    }));

    await this.workItemRepo.updateTasksRank(updates);
    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);

    return { message: 'Task reordered successfully' };
  }

  async bulkUpdate(
    projectId: string,
    dto: BulkUpdateWorkItemDto,
    userId?: string,
  ) {
    const payload = dto.data || (dto as any);
    const data: any = {};

    if (payload.columnId !== undefined) {
      data.columnId = payload.columnId;
      data.completed = this.isDoneColumn(payload.columnId);
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

    const result = await this.workItemRepo.bulkUpdateTasks(
      projectId,
      dto.taskIds,
      data,
    );

    await this.invalidateTaskCache(projectId, undefined, payload.cycleId);

    this.eventEmitter?.emit(
      'task.updated',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: projectId,
        verb: 'updated',
        actorId: userId || '',
        projectId,
      }),
    );

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
    const source = await this.workItemRepo.findTaskById(taskId);
    if (!source) {
      throw new NotFoundException('Task not found');
    }

    const projectId = targetProjectId || source.projectId;
    const { identifier, sequenceNumber } =
      await this.workItemRepo.nextProjectTaskIdentifier(projectId);

    const columnCount = await this.workItemRepo.countColumnTasks(
      projectId,
      source.columnId,
    );

    const cloned = await this.workItemRepo.createTask({
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

    await this.invalidateTaskCache(projectId, cloned.id, cloned.cycleId);

    this.eventEmitter?.emit(
      'task.created',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: cloned.id,
        verb: 'created',
        actorId: userId,
        projectId,
      }),
    );

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
    userId?: string,
  ) {
    const task = await this.workItemRepo.findTaskById(taskId);
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
    const updated = await this.workItemRepo.updateTask(taskId, {
      attachments: updatedAttachments,
    });

    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);

    this.eventEmitter?.emit(
      'task.updated',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: taskId,
        verb: 'updated',
        actorId: userId || '',
        projectId: task.projectId,
      }),
    );

    return { task: this.formatTask(updated), attachment: newAttachment };
  }

  async deleteAttachment(
    taskId: string,
    attachmentId: string,
    userId?: string,
  ) {
    const task = await this.workItemRepo.findTaskById(taskId);
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const existingAttachments = Array.isArray(task.attachments)
      ? (task.attachments as any[])
      : [];
    const updatedAttachments = existingAttachments.filter(
      (att) => att.id !== attachmentId && att.attachmentId !== attachmentId,
    );

    const updated = await this.workItemRepo.updateTask(taskId, {
      attachments: updatedAttachments,
    });

    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);

    this.eventEmitter?.emit(
      'task.updated',
      new DomainActivityEvent({
        entityType: 'task' as unknown as EntityType,
        entityId: taskId,
        verb: 'updated',
        actorId: userId || '',
        projectId: task.projectId,
      }),
    );

    return {
      message: 'Attachment removed successfully',
      task: this.formatTask(updated),
    };
  }
}

// Backward compatibility alias
export const TaskService = WorkItemService;
export type TaskService = WorkItemService;
