import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CoreRepository } from './core.repository';
import { IdHandler } from './handlers/id.handler';
import { RankHandler } from './handlers/rank.handler';
import { CloneHandler } from './handlers/clone.handler';
import { EventDispatcher } from './handlers/event.dispatcher';
import { CreateWorkItemDto } from './dto/create.dto';
import { UpdateWorkItemDto } from './dto/update.dto';
import { QueryWorkItemDto } from './dto/query.dto';
import {
  BulkUpdateWorkItemDto,
  BulkDeleteWorkItemDto,
  ReorderWorkItemDto,
} from './dto/bulk.dto';
import { formatWorkItem, mapPriority } from './utils/work-item.util';
import {
  parseWorkItemStates,
  isStateCompleted,
} from '../state/utils/state.util';
import { isUuid } from '@/core/utils/uuid.util';
import { WORK_ITEM_REDIS_KEYS } from './constants/redis-keys.constant';

@Injectable()
export class CoreService {
  constructor(
    private readonly workItemRepository: CoreRepository,
    private readonly idHandler: IdHandler,
    private readonly rankHandler: RankHandler,
    private readonly cloneHandler: CloneHandler,
    private readonly eventDispatcher: EventDispatcher,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

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
    if (taskId)
      deletions.push(this.cache.del(WORK_ITEM_REDIS_KEYS.WorkItem(taskId)));
    if (cycleId) {
      deletions.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.cycle(cycleId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectCycles(projectId)),
      );
    }
    await Promise.all(deletions).catch(() => null);
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async getProjectTasks(projectId: string, filter?: string | QueryWorkItemDto) {
    const isSimpleCycle = typeof filter === 'string';
    const isUnfiltered =
      !filter ||
      (typeof filter === 'object' && Object.keys(filter).length === 0);
    const cacheKey = isSimpleCycle
      ? `${WORK_ITEM_REDIS_KEYS.projectTasks(projectId)}:cycle:${filter}`
      : WORK_ITEM_REDIS_KEYS.projectTasks(projectId);

    const fetchTasks = async () => {
      const filterOptions =
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

      const taskRecords = await this.workItemRepository.findProjectTasks(
        projectId,
        filterOptions,
      );
      return taskRecords.map(formatWorkItem).filter(Boolean);
    };

    if (this.cache && (isUnfiltered || isSimpleCycle)) {
      const tasks = await this.cache.wrap(cacheKey, fetchTasks, 300);
      return { tasks };
    }
    const tasks = await fetchTasks();
    return { tasks };
  }

  async getTaskById(taskId: string) {
    if (this.cache) {
      const cached = await this.cache.get<any>(
        WORK_ITEM_REDIS_KEYS.WorkItem(taskId),
      );
      if (cached) {
        const formatted = formatWorkItem(cached);
        return { task: formatted, workItem: formatted, WorkItem: formatted, item: formatted };
      }
    }
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('WorkItem not found');
    if (this.cache)
      await this.cache.set(WORK_ITEM_REDIS_KEYS.WorkItem(taskId), task, 600);
    const formatted = formatWorkItem(task);
    return { task: formatted, workItem: formatted, WorkItem: formatted, item: formatted };
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async createTask(
    projectId: string,
    authorId: string,
    createWorkItemDto: CreateWorkItemDto,
  ) {
    const rawProject =
      await this.workItemRepository.findProjectWithColumns(projectId);
    if (!rawProject) throw new NotFoundException('Project not found');

    const columns = parseWorkItemStates(rawProject.taskColumns);
    const targetColumn =
      createWorkItemDto.columnId ||
      (columns.length > 0 ? columns[0].id : 'backlog');
    const columnCount = await this.workItemRepository.countColumnTasks(
      projectId,
      targetColumn,
    );
    const { identifier, sequenceNumber } =
      await this.idHandler.nextIdentifier(projectId);

    const task = await this.workItemRepository.createTask({
      title: createWorkItemDto.title,
      content: createWorkItemDto.content || createWorkItemDto.description || '',
      columnId: targetColumn,
      rank: createWorkItemDto.rank ?? columnCount,
      priority: mapPriority(createWorkItemDto.priority),
      identifier,
      sequenceNumber,
      labels: createWorkItemDto.labels || [],
      completed:
        createWorkItemDto.completed !== undefined
          ? createWorkItemDto.completed
          : isStateCompleted(targetColumn),
      relations: createWorkItemDto.relations || [],
      startDate: createWorkItemDto.startDate
        ? new Date(createWorkItemDto.startDate)
        : null,
      dueDate: createWorkItemDto.dueDate
        ? new Date(createWorkItemDto.dueDate)
        : null,
      timeSpent: createWorkItemDto.timeSpent || 0,
      assigneeIds:
        createWorkItemDto.assigneeIds && Array.isArray(createWorkItemDto.assigneeIds)
          ? createWorkItemDto.assigneeIds
          : createWorkItemDto.assigneeId
            ? [createWorkItemDto.assigneeId]
            : [],
      project: { connect: { id: projectId } },
      author: { connect: { id: authorId } },
      ...(createWorkItemDto.assigneeId
        ? { assignee: { connect: { id: createWorkItemDto.assigneeId } } }
        : {}),
      ...(createWorkItemDto.cycleId
        ? { cycle: { connect: { id: createWorkItemDto.cycleId } } }
        : {}),
      ...(createWorkItemDto.parentTaskId
        ? { parentTask: { connect: { id: createWorkItemDto.parentTaskId } } }
        : {}),
    });

    await this.invalidateTaskCache(
      projectId,
      task.id,
      createWorkItemDto.cycleId,
    );
    this.eventDispatcher.emitTaskCreated({
      taskId: task.id,
      actorId: authorId,
      projectId,
      columnId: targetColumn,
      title: task.title,
      identifier: task.identifier,
      sequenceNumber: task.sequenceNumber,
    });
    const formatted = formatWorkItem(task);
    return { task: formatted, workItem: formatted, WorkItem: formatted, item: formatted };
  }

  async createSubtask(
    parentTaskId: string,
    authorId: string,
    createWorkItemDto: CreateWorkItemDto,
  ) {
    const parent = await this.workItemRepository.findTaskById(parentTaskId);
    if (!parent) throw new NotFoundException('Parent work item not found');

    return this.createTask(parent.projectId, authorId, {
      ...createWorkItemDto,
      parentTaskId,
      cycleId: createWorkItemDto.cycleId || parent.cycleId || undefined,
    });
  }

  async updateTask(
    taskId: string,
    updateWorkItemDto: UpdateWorkItemDto,
    userId?: string,
  ) {
    const existing = await this.workItemRepository.findTaskById(taskId);
    if (!existing) throw new NotFoundException('WorkItem not found');

    const updated = await this.workItemRepository.updateTask(taskId, {
      ...(updateWorkItemDto.title !== undefined && {
        title: updateWorkItemDto.title,
      }),
      ...(updateWorkItemDto.content !== undefined && {
        content: updateWorkItemDto.content,
      }),
      ...(updateWorkItemDto.description !== undefined && {
        content: updateWorkItemDto.description,
      }),
      ...(updateWorkItemDto.columnId !== undefined && {
        columnId: updateWorkItemDto.columnId,
        completed: isStateCompleted(updateWorkItemDto.columnId),
      }),
      ...(updateWorkItemDto.completed !== undefined && {
        completed: updateWorkItemDto.completed,
      }),
      ...(updateWorkItemDto.priority !== undefined && {
        priority: mapPriority(updateWorkItemDto.priority),
      }),
      ...(updateWorkItemDto.rank !== undefined && {
        rank: updateWorkItemDto.rank,
      }),
      ...(updateWorkItemDto.labels !== undefined && {
        labels: updateWorkItemDto.labels,
      }),
      ...(updateWorkItemDto.relations !== undefined && {
        relations: updateWorkItemDto.relations,
      }),
      ...(updateWorkItemDto.subscriberIds !== undefined && {
        subscriberIds: updateWorkItemDto.subscriberIds,
      }),
      ...(updateWorkItemDto.startDate !== undefined && {
        startDate: updateWorkItemDto.startDate
          ? new Date(updateWorkItemDto.startDate)
          : null,
      }),
      ...(updateWorkItemDto.dueDate !== undefined && {
        dueDate: updateWorkItemDto.dueDate
          ? new Date(updateWorkItemDto.dueDate)
          : null,
      }),
      ...(updateWorkItemDto.timeSpent !== undefined && {
        timeSpent: updateWorkItemDto.timeSpent,
      }),
      ...(updateWorkItemDto.assigneeId !== undefined && {
        assignee: updateWorkItemDto.assigneeId
          ? { connect: { id: updateWorkItemDto.assigneeId } }
          : { disconnect: true },
      }),
      ...(updateWorkItemDto.cycleId !== undefined && {
        cycle: updateWorkItemDto.cycleId
          ? { connect: { id: updateWorkItemDto.cycleId } }
          : { disconnect: true },
      }),
      ...(updateWorkItemDto.parentTaskId !== undefined && {
        parentTask: updateWorkItemDto.parentTaskId
          ? { connect: { id: updateWorkItemDto.parentTaskId } }
          : { disconnect: true },
      }),
      ...(updateWorkItemDto.assigneeIds !== undefined && {
        assigneeIds: updateWorkItemDto.assigneeIds,
      }),
    });

    await this.invalidateTaskCache(
      existing.projectId,
      taskId,
      existing.cycleId,
    );

    this.eventDispatcher.dispatchUpdateEvents(existing, updateWorkItemDto, userId);
    const formatted = formatWorkItem(updated);
    return { task: formatted, workItem: formatted, WorkItem: formatted, item: formatted };
  }

  async deleteTask(taskId: string, userId?: string) {
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('WorkItem not found');

    await this.workItemRepository.deleteTask(taskId);
    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);
    this.eventDispatcher.emitTaskDeleted({
      taskId,
      actorId: userId,
      projectId: task.projectId,
    });
    return { message: 'WorkItem deleted successfully' };
  }

  async reorderTask(taskId: string, reorderWorkItemDto: ReorderWorkItemDto) {
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('WorkItem not found');

    const targetColumn = reorderWorkItemDto.columnId || task.columnId;
    const targetRank = reorderWorkItemDto.rank ?? 0;
    const columnTasks = await this.workItemRepository.findColumnTasks(
      task.projectId,
      targetColumn,
    );

    const updates = this.rankHandler.calculateReorder(
      columnTasks,
      taskId,
      targetColumn,
      targetRank,
    );

    await this.workItemRepository.updateTasksRank(updates);
    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);
    this.eventDispatcher.emitTaskReordered({
      taskId,
      projectId: task.projectId,
      columnId: targetColumn,
      rank: targetRank,
    });
    return { message: 'WorkItem reordered successfully' };
  }

  async bulkUpdate(
    projectId: string,
    bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
    userId?: string,
  ) {
    const payload =
      bulkUpdateWorkItemDto.data || (bulkUpdateWorkItemDto as any);

    const rawIds = bulkUpdateWorkItemDto.workItemIds || bulkUpdateWorkItemDto.taskIds || [];

    // Support bulk add single label to all selected tasks
    if (payload.addLabel !== undefined && typeof payload.addLabel === 'string') {
      const labelId = payload.addLabel;
      const validIds = rawIds.filter(isUuid);
      const tasks = await this.workItemRepository.findTasksByIds(validIds);
      await Promise.all(
        tasks.map((t) => {
          const current = Array.isArray(t.labels) ? t.labels : [];
          if (current.includes(labelId)) return Promise.resolve();
          const next = [...current, labelId];
          return this.workItemRepository.updateTask(t.id, { labels: next });
        }),
      );
      await this.invalidateTaskCache(projectId);
      return {
        message: `Label added to ${tasks.length} work items`,
        count: tasks.length,
      };
    }

    // Support bulk remove single label from all selected tasks
    if (payload.removeLabel !== undefined && typeof payload.removeLabel === 'string') {
      const labelId = payload.removeLabel;
      const validIds = rawIds.filter(isUuid);
      const tasks = await this.workItemRepository.findTasksByIds(validIds);
      await Promise.all(
        tasks.map((t) => {
          const current = Array.isArray(t.labels) ? t.labels : [];
          if (!current.includes(labelId)) return Promise.resolve();
          const next = current.filter((l) => l !== labelId);
          return this.workItemRepository.updateTask(t.id, { labels: next });
        }),
      );
      await this.invalidateTaskCache(projectId);
      return {
        message: `Label removed from ${tasks.length} work items`,
        count: tasks.length,
      };
    }

    const data: any = {};
    if (payload.columnId !== undefined) {
      data.columnId = payload.columnId;
      data.completed = isStateCompleted(payload.columnId);
    }
    if (payload.assigneeId !== undefined) data.assigneeId = payload.assigneeId;
    if (payload.priority !== undefined)
      data.priority = mapPriority(payload.priority);
    if (payload.cycleId !== undefined) data.cycleId = payload.cycleId;
    if (payload.dueDate !== undefined)
      data.dueDate = payload.dueDate ? new Date(payload.dueDate) : null;
    if (payload.clearLabels === true) {
      data.labels = [];
    } else if (payload.labels !== undefined && Array.isArray(payload.labels)) {
      data.labels = payload.labels;
    }

    const result = await this.workItemRepository.bulkUpdateTasks(
      projectId,
      rawIds,
      data,
    );
    await this.invalidateTaskCache(projectId, undefined, payload.cycleId);
    this.eventEmitter?.emit('task.updated', {
      entityType: 'task',
      entityId: projectId,
      verb: 'updated',
      actorId: userId || '',
      projectId,
    });
    return {
      message: `${result.count} work items updated successfully`,
      count: result.count,
    };
  }

  async bulkDelete(
    projectId: string,
    bulkDeleteWorkItemDto: BulkDeleteWorkItemDto,
    userId?: string,
  ) {
    const rawIds = bulkDeleteWorkItemDto.workItemIds || bulkDeleteWorkItemDto.taskIds || [];
    const result = await this.workItemRepository.bulkDeleteTasks(
      projectId,
      rawIds,
    );
    await this.invalidateTaskCache(projectId);
    this.eventEmitter?.emit('task.deleted', {
      entityType: 'task',
      entityId: projectId,
      verb: 'deleted',
      actorId: userId || '',
      projectId,
    });
    return {
      message: `${result.count} work items deleted successfully`,
      count: result.count,
    };
  }

  async duplicateTask(
    taskId: string,
    userId: string,
    destinationProjectId?: string,
  ) {
    const source = await this.workItemRepository.findTaskById(taskId);
    if (!source) throw new NotFoundException('WorkItem not found');

    const sourceMemberRole =
      await this.workItemRepository.findProjectMemberRole(
        source.projectId,
        userId,
      );
    if (!sourceMemberRole)
      throw new ForbiddenException(
        'Insufficient permissions to access source task',
      );

    const { cloneData, targetProjectId } =
      await this.cloneHandler.buildCloneData(
        source,
        userId,
        destinationProjectId,
      );
    const cloned = await this.workItemRepository.createTask(cloneData);
    await this.invalidateTaskCache(targetProjectId, cloned.id, cloned.cycleId);

    this.eventEmitter?.emit('task.duplicated', {
      entityType: 'task',
      entityId: cloned.id,
      verb: 'created',
      actorId: userId,
      projectId: targetProjectId,
    });

    const formatted = formatWorkItem(cloned);
    return {
      task: formatted,
      workItem: formatted,
      WorkItem: formatted,
      item: formatted,
      message: 'WorkItem duplicated successfully',
    };
  }

  async convertToRootTask(taskId: string) {
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('WorkItem not found');

    const updated = await this.workItemRepository.disconnectParentTask(taskId);

    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);
    const formatted = formatWorkItem(updated);
    return {
      message: 'WorkItem converted to root work item successfully',
      task: formatted,
      workItem: formatted,
      WorkItem: formatted,
      item: formatted,
    };
  }
}

export const WorkItemService = CoreService;
export type WorkItemService = CoreService;
export const TaskService = CoreService;
export type TaskService = CoreService;
