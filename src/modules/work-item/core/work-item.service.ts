import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WorkItemRepository } from './work-item.repository';
import { WorkItemIdHandler } from './handlers/work-item-id.handler';
import { WorkItemRankHandler } from './handlers/work-item-rank.handler';
import { WorkItemCloneHandler } from './handlers/work-item-clone.handler';
import { CreateWorkItemDto } from './dto/create-work-item.dto';
import { UpdateWorkItemDto } from './dto/update-work-item.dto';
import { QueryWorkItemDto } from './dto/query-work-item.dto';
import {
  BulkUpdateWorkItemDto,
  BulkDeleteWorkItemDto,
  ReorderWorkItemDto,
} from './dto/bulk-work-item.dto';
import { formatWorkItem, mapPriority } from './utils/work-item.util';
import { parseWorkItemStates, isStateCompleted } from '../state/utils/state.util';
import { WORK_ITEM_REDIS_KEYS } from './constants/redis-keys.constant';

@Injectable()
export class WorkItemService {
  constructor(
    private readonly workItemRepository: WorkItemRepository,
    private readonly idHandler: WorkItemIdHandler,
    private readonly rankHandler: WorkItemRankHandler,
    private readonly cloneHandler: WorkItemCloneHandler,
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
    if (taskId) deletions.push(this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)));
    if (cycleId) {
      deletions.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.cycle(cycleId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectCycles(projectId)),
      );
    }
    await Promise.all(deletions).catch(() => null);
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async getWorkspaceTasks(workspaceId: string) {
    const taskRecords = await this.workItemRepository.findWorkspaceTasks(workspaceId);
    return { tasks: taskRecords.map(formatWorkItem).filter(Boolean) };
  }

  async getProjectTasks(projectId: string, filter?: string | QueryWorkItemDto) {
    const isSimpleCycle = typeof filter === 'string';
    const isUnfiltered =
      !filter || (typeof filter === 'object' && Object.keys(filter).length === 0);
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
      const cached = await this.cache.get<any>(WORK_ITEM_REDIS_KEYS.task(taskId));
      if (cached) return { task: formatWorkItem(cached) };
    }
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('Task not found');
    if (this.cache) await this.cache.set(WORK_ITEM_REDIS_KEYS.task(taskId), task, 600);
    return { task: formatWorkItem(task) };
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async createTask(
    projectId: string,
    authorId: string,
    createWorkItemDto: CreateWorkItemDto,
  ) {
    const rawProject = await this.workItemRepository.findProjectWithColumns(projectId);
    if (!rawProject) throw new NotFoundException('Project not found');

    const columns = parseWorkItemStates(rawProject.taskColumns);
    const targetColumn =
      createWorkItemDto.columnId || (columns.length > 0 ? columns[0].id : 'backlog');
    const columnCount = await this.workItemRepository.countColumnTasks(
      projectId,
      targetColumn,
    );
    const { identifier, sequenceNumber } = await this.idHandler.nextIdentifier(
      projectId,
    );

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
      startDate: createWorkItemDto.startDate ? new Date(createWorkItemDto.startDate) : null,
      dueDate: createWorkItemDto.dueDate ? new Date(createWorkItemDto.dueDate) : null,
      timeSpent: createWorkItemDto.timeSpent || 0,
      project: { connect: { id: projectId } },
      author: { connect: { id: authorId } },
      ...(createWorkItemDto.assigneeId ? { assignee: { connect: { id: createWorkItemDto.assigneeId } } } : {}),
      ...(createWorkItemDto.cycleId ? { cycle: { connect: { id: createWorkItemDto.cycleId } } } : {}),
      ...(createWorkItemDto.parentTaskId
        ? { parentTask: { connect: { id: createWorkItemDto.parentTaskId } } }
        : {}),
    });

    await this.invalidateTaskCache(projectId, task.id, createWorkItemDto.cycleId);
    this.eventEmitter?.emit('task.created', {
      entityType: 'task',
      entityId: task.id,
      verb: 'created',
      actorId: authorId,
      projectId,
      workspaceId: task.project?.workspaceId,
      columnId: targetColumn,
    });
    return { task: formatWorkItem(task) };
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
    if (!existing) throw new NotFoundException('Task not found');

    const updated = await this.workItemRepository.updateTask(taskId, {
      ...(updateWorkItemDto.title !== undefined && { title: updateWorkItemDto.title }),
      ...(updateWorkItemDto.content !== undefined && { content: updateWorkItemDto.content }),
      ...(updateWorkItemDto.description !== undefined && { content: updateWorkItemDto.description }),
      ...(updateWorkItemDto.columnId !== undefined && {
        columnId: updateWorkItemDto.columnId,
        completed: isStateCompleted(updateWorkItemDto.columnId),
      }),
      ...(updateWorkItemDto.completed !== undefined && { completed: updateWorkItemDto.completed }),
      ...(updateWorkItemDto.priority !== undefined && { priority: mapPriority(updateWorkItemDto.priority) }),
      ...(updateWorkItemDto.rank !== undefined && { rank: updateWorkItemDto.rank }),
      ...(updateWorkItemDto.labels !== undefined && { labels: updateWorkItemDto.labels }),
      ...(updateWorkItemDto.relations !== undefined && { relations: updateWorkItemDto.relations }),
      ...(updateWorkItemDto.startDate !== undefined && {
        startDate: updateWorkItemDto.startDate ? new Date(updateWorkItemDto.startDate) : null,
      }),
      ...(updateWorkItemDto.dueDate !== undefined && {
        dueDate: updateWorkItemDto.dueDate ? new Date(updateWorkItemDto.dueDate) : null,
      }),
      ...(updateWorkItemDto.timeSpent !== undefined && { timeSpent: updateWorkItemDto.timeSpent }),
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
    });

    await this.invalidateTaskCache(existing.projectId, taskId, existing.cycleId);

    // Emit granular field change events for feed, transitions, and history
    if (
      updateWorkItemDto.columnId !== undefined &&
      updateWorkItemDto.columnId !== existing.columnId
    ) {
      this.eventEmitter?.emit('task.state.changed', {
        entityType: 'task',
        entityId: taskId,
        verb: 'transitioned',
        field: 'state',
        oldValue: existing.columnId,
        newValue: updateWorkItemDto.columnId,
        actorId: userId || '',
        projectId: existing.projectId,
        workspaceId: existing.project?.workspaceId,
      });
    }

    if (updateWorkItemDto.priority !== undefined) {
      const newPriority = mapPriority(updateWorkItemDto.priority);
      if (newPriority !== existing.priority) {
        this.eventEmitter?.emit('task.priority.changed', {
          entityType: 'task',
          entityId: taskId,
          verb: 'updated',
          field: 'priority',
          oldValue: existing.priority,
          newValue: newPriority,
          actorId: userId || '',
          projectId: existing.projectId,
          workspaceId: existing.project?.workspaceId,
        });
      }
    }

    if (
      updateWorkItemDto.title !== undefined &&
      updateWorkItemDto.title !== existing.title
    ) {
      this.eventEmitter?.emit('task.title.changed', {
        entityType: 'task',
        entityId: taskId,
        verb: 'updated',
        field: 'title',
        oldValue: existing.title,
        newValue: updateWorkItemDto.title,
        actorId: userId || '',
        projectId: existing.projectId,
        workspaceId: existing.project?.workspaceId,
      });
    }

    const newContent = updateWorkItemDto.description ?? updateWorkItemDto.content;
    if (
      newContent !== undefined &&
      newContent !== (existing.content || '')
    ) {
      this.eventEmitter?.emit('task.content.changed', {
        entityType: 'task',
        entityId: taskId,
        verb: 'updated',
        field: 'description',
        oldValue: existing.content || '',
        newValue: newContent,
        actorId: userId || '',
        projectId: existing.projectId,
        workspaceId: existing.project?.workspaceId,
      });
    }

    if (
      updateWorkItemDto.cycleId !== undefined &&
      updateWorkItemDto.cycleId !== existing.cycleId
    ) {
      this.eventEmitter?.emit('task.cycle.changed', {
        entityType: 'task',
        entityId: taskId,
        verb: 'updated',
        field: 'cycle',
        oldValue: existing.cycleId || '',
        newValue: updateWorkItemDto.cycleId || '',
        actorId: userId || '',
        projectId: existing.projectId,
        workspaceId: existing.project?.workspaceId,
      });
    }

    this.eventEmitter?.emit('task.updated', {
      entityType: 'task',
      entityId: taskId,
      verb: 'updated',
      actorId: userId || '',
      projectId: existing.projectId,
      workspaceId: existing.project?.workspaceId,
    });
    return { task: formatWorkItem(updated) };
  }

  async deleteTask(taskId: string, userId?: string) {
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('Task not found');

    await this.workItemRepository.deleteTask(taskId);
    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);
    this.eventEmitter?.emit('task.deleted', {
      entityType: 'task',
      entityId: taskId,
      verb: 'deleted',
      actorId: userId || '',
      projectId: task.projectId,
      workspaceId: task.project?.workspaceId,
    });
    return { message: 'Task deleted successfully' };
  }

  async reorderTask(taskId: string, reorderWorkItemDto: ReorderWorkItemDto) {
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('Task not found');

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
    return { message: 'Task reordered successfully' };
  }

  async bulkUpdate(
    projectId: string,
    bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
    userId?: string,
  ) {
    const payload = bulkUpdateWorkItemDto.data || (bulkUpdateWorkItemDto as any);
    const data: any = {};
    if (payload.columnId !== undefined) {
      data.columnId = payload.columnId;
      data.completed = isStateCompleted(payload.columnId);
    }
    if (payload.assigneeId !== undefined) data.assigneeId = payload.assigneeId;
    if (payload.priority !== undefined) data.priority = mapPriority(payload.priority);
    if (payload.cycleId !== undefined) data.cycleId = payload.cycleId;
    if (payload.dueDate !== undefined)
      data.dueDate = payload.dueDate ? new Date(payload.dueDate) : null;

    const result = await this.workItemRepository.bulkUpdateTasks(
      projectId,
      bulkUpdateWorkItemDto.taskIds,
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
      message: `${result.count} tasks updated successfully`,
      count: result.count,
    };
  }

  async bulkDelete(
    projectId: string,
    bulkDeleteWorkItemDto: BulkDeleteWorkItemDto,
    userId?: string,
  ) {
    const result = await this.workItemRepository.bulkDeleteTasks(
      projectId,
      bulkDeleteWorkItemDto.taskIds,
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
      message: `${result.count} tasks deleted successfully`,
      count: result.count,
    };
  }

  async duplicateTask(
    taskId: string,
    userId: string,
    destinationProjectId?: string,
  ) {
    const source = await this.workItemRepository.findTaskById(taskId);
    if (!source) throw new NotFoundException('Task not found');

    const sourceMemberRole = await this.workItemRepository.findProjectMemberRole(
      source.projectId,
      userId,
    );
    if (!sourceMemberRole)
      throw new ForbiddenException('Insufficient permissions to access source task');

    const { cloneData, targetProjectId } =
      await this.cloneHandler.buildCloneData(source, userId, destinationProjectId);
    const cloned = await this.workItemRepository.createTask(cloneData);
    await this.invalidateTaskCache(targetProjectId, cloned.id, cloned.cycleId);

    this.eventEmitter?.emit('task.duplicated', {
      entityType: 'task',
      entityId: cloned.id,
      verb: 'created',
      actorId: userId,
      projectId: targetProjectId,
      workspaceId: cloned.project?.workspaceId,
    });

    return {
      task: formatWorkItem(cloned),
      message: 'Task duplicated successfully',
    };
  }

  async convertToRootTask(taskId: string) {
    const task = await this.workItemRepository.findTaskById(taskId);
    if (!task) throw new NotFoundException('Task not found');

    const updated = await this.workItemRepository.disconnectParentTask(taskId);

    await this.invalidateTaskCache(task.projectId, taskId, task.cycleId);
    return {
      message: 'Task converted to root work item successfully',
      task: formatWorkItem(updated),
    };
  }
}
