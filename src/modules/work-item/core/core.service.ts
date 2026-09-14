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
import { isStateCompleted } from '../state/utils/state.util';
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

  private async invalidateWorkItemCache(
    projectId: string,
    workItemId?: string,
    cycleId?: string | null,
  ) {
    if (!this.cache) return;
    const deletions: Promise<any>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId)),
      this.cache.del(`flux:proj:overview:${projectId}`),
    ];
    if (workItemId)
      deletions.push(this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(workItemId)));
    if (cycleId) {
      deletions.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.cycle(cycleId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectCycles(projectId)),
      );
    }
    await Promise.all(deletions).catch(() => null);
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async getProjectWorkItems(
    projectId: string,
    filter?: string | QueryWorkItemDto,
  ) {
    const isSimpleCycle = typeof filter === 'string';
    const isUnfiltered =
      !filter ||
      (typeof filter === 'object' && Object.keys(filter).length === 0);
    const cacheKey = isSimpleCycle
      ? `${WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId)}:cycle:${filter}`
      : WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId);

    const fetchWorkItems = async () => {
      const filterOptions =
        typeof filter === 'string'
          ? filter
          : filter
            ? {
                cycleId: filter.cycleId || filter.cycle,
                columnId: filter.columnId,
                priority: filter.priority,
                assigneeId: filter.assigneeId,
                parentWorkItemId: filter.parentWorkItemId,
                completed: filter.completed,
                search: filter.search,
                limit: filter.limit,
                offset:
                  filter.page && filter.limit
                    ? (filter.page - 1) * filter.limit
                    : undefined,
              }
            : undefined;

      const records = await this.workItemRepository.findProjectWorkItems(
        projectId,
        filterOptions,
      );
      return records.map(formatWorkItem).filter(Boolean);
    };

    if (this.cache && (isUnfiltered || isSimpleCycle)) {
      const workItems = await this.cache.wrap(cacheKey, fetchWorkItems, 300);
      return { workItems };
    }
    const workItems = await fetchWorkItems();
    return { workItems };
  }

  async getWorkItemById(workItemId: string) {
    if (this.cache) {
      const cached = await this.cache.get<any>(
        WORK_ITEM_REDIS_KEYS.workItem(workItemId),
      );
      if (cached) {
        const formatted = formatWorkItem(cached);
        return { workItem: formatted, item: formatted };
      }
    }
    const item = await this.workItemRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');
    if (this.cache)
      await this.cache.set(
        WORK_ITEM_REDIS_KEYS.workItem(workItemId),
        item,
        600,
      );
    const formatted = formatWorkItem(item);
    return { workItem: formatted, item: formatted };
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async createWorkItem(
    projectId: string,
    authorId: string,
    createWorkItemDto: CreateWorkItemDto,
  ) {
    const rawProject =
      await this.workItemRepository.findProjectWithColumns(projectId);
    if (!rawProject) throw new NotFoundException('Project not found');

    const defaultState =
      rawProject.states?.find((s) => s.isDefault) || rawProject.states?.[0];
    const targetColumn =
      createWorkItemDto.columnId ||
      (defaultState ? defaultState.id : 'backlog');
    const columnCount = await this.workItemRepository.countColumnWorkItems(
      projectId,
      targetColumn,
    );
    const { identifier, sequenceNumber } =
      await this.idHandler.nextIdentifier(projectId);

    const parentId = createWorkItemDto.parentWorkItemId;

    const workItem = await this.workItemRepository.createWorkItem({
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
        createWorkItemDto.assigneeIds &&
        Array.isArray(createWorkItemDto.assigneeIds)
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
      ...(parentId ? { parentWorkItem: { connect: { id: parentId } } } : {}),
    });

    await this.invalidateWorkItemCache(
      projectId,
      workItem.id,
      createWorkItemDto.cycleId,
    );
    this.eventDispatcher.emitWorkItemCreated({
      workItemId: workItem.id,
      actorId: authorId,
      projectId,
      columnId: targetColumn,
      title: workItem.title,
      identifier: workItem.identifier,
      sequenceNumber: workItem.sequenceNumber,
    });
    const formatted = formatWorkItem(workItem);
    return { workItem: formatted, item: formatted };
  }

  async createChildWorkItem(
    parentWorkItemId: string,
    authorId: string,
    createWorkItemDto: CreateWorkItemDto,
  ) {
    const parent =
      await this.workItemRepository.findWorkItemById(parentWorkItemId);
    if (!parent) throw new NotFoundException('Parent work item not found');

    return this.createWorkItem(parent.projectId, authorId, {
      ...createWorkItemDto,
      parentWorkItemId,
      cycleId: createWorkItemDto.cycleId || parent.cycleId || undefined,
    });
  }

  async updateWorkItem(
    workItemId: string,
    updateWorkItemDto: UpdateWorkItemDto,
    userId?: string,
  ) {
    const existing = await this.workItemRepository.findWorkItemById(workItemId);
    if (!existing) throw new NotFoundException('WorkItem not found');

    const parentId = updateWorkItemDto.parentWorkItemId;

    const updated = await this.workItemRepository.updateWorkItem(existing.id, {
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
      ...(parentId !== undefined && {
        parentWorkItem: parentId
          ? { connect: { id: parentId } }
          : { disconnect: true },
      }),
      ...(updateWorkItemDto.assigneeIds !== undefined && {
        assigneeIds: updateWorkItemDto.assigneeIds,
      }),
    });

    await this.invalidateWorkItemCache(
      existing.projectId,
      existing.id,
      existing.cycleId,
    );

    this.eventDispatcher.dispatchUpdateEvents(
      existing,
      updateWorkItemDto,
      userId,
    );
    const formatted = formatWorkItem(updated);
    return { workItem: formatted, item: formatted };
  }

  async deleteWorkItem(workItemId: string, userId?: string) {
    const item = await this.workItemRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    await this.workItemRepository.softDeleteWorkItem(item.id);
    await this.invalidateWorkItemCache(item.projectId, item.id, item.cycleId);
    this.eventDispatcher.emitWorkItemDeleted({
      workItemId: item.id,
      actorId: userId,
      projectId: item.projectId,
    });
    return { message: 'WorkItem deleted successfully' };
  }

  async reorderWorkItem(
    workItemId: string,
    reorderWorkItemDto: ReorderWorkItemDto,
  ) {
    const item = await this.workItemRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    const targetColumn = reorderWorkItemDto.columnId || item.columnId;
    const targetRank = reorderWorkItemDto.rank ?? 0;
    const columnItems = await this.workItemRepository.findColumnWorkItems(
      item.projectId,
      targetColumn,
    );

    const updates = this.rankHandler.calculateReorder(
      columnItems,
      item.id,
      targetColumn,
      targetRank,
      undefined,
      item,
    );

    await this.workItemRepository.updateWorkItemsRank(updates);
    await this.invalidateWorkItemCache(item.projectId, item.id, item.cycleId);
    this.eventDispatcher.emitWorkItemReordered({
      workItemId: item.id,
      projectId: item.projectId,
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

    const rawIds =
      bulkUpdateWorkItemDto.workItemIds || bulkUpdateWorkItemDto.ids || [];

    // Support bulk add single label to all selected items
    if (
      payload.addLabel !== undefined &&
      typeof payload.addLabel === 'string'
    ) {
      const labelId = payload.addLabel;
      const validIds = rawIds.filter(isUuid);
      const allItems =
        await this.workItemRepository.findWorkItemsByIds(validIds);
      const items = allItems.filter((t) => t.projectId === projectId);
      await Promise.all(
        items.map((t) => {
          const current = Array.isArray(t.labels) ? t.labels : [];
          if (current.includes(labelId)) return Promise.resolve();
          const next = [...current, labelId];
          return this.workItemRepository.updateWorkItem(t.id, { labels: next });
        }),
      );
      await this.invalidateWorkItemCache(projectId);
      return {
        message: `Label added to ${items.length} work items`,
        count: items.length,
      };
    }

    // Support bulk remove single label from all selected items
    if (
      payload.removeLabel !== undefined &&
      typeof payload.removeLabel === 'string'
    ) {
      const labelId = payload.removeLabel;
      const validIds = rawIds.filter(isUuid);
      const allItems =
        await this.workItemRepository.findWorkItemsByIds(validIds);
      const items = allItems.filter((t) => t.projectId === projectId);
      await Promise.all(
        items.map((t) => {
          const current = Array.isArray(t.labels) ? t.labels : [];
          if (!current.includes(labelId)) return Promise.resolve();
          const next = current.filter((l) => l !== labelId);
          return this.workItemRepository.updateWorkItem(t.id, { labels: next });
        }),
      );
      await this.invalidateWorkItemCache(projectId);
      return {
        message: `Label removed from ${items.length} work items`,
        count: items.length,
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

    const result = await this.workItemRepository.bulkUpdateWorkItems(
      projectId,
      rawIds,
      data,
    );
    await this.invalidateWorkItemCache(projectId, undefined, payload.cycleId);
    this.eventDispatcher.emitBulkUpdated(projectId, userId);
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
    const rawIds =
      bulkDeleteWorkItemDto.workItemIds || bulkDeleteWorkItemDto.ids || [];
    const result = await this.workItemRepository.bulkDeleteWorkItems(
      projectId,
      rawIds,
    );
    await this.invalidateWorkItemCache(projectId);
    this.eventDispatcher.emitBulkDeleted(projectId, userId);
    return {
      message: `${result.count} work items deleted successfully`,
      count: result.count,
    };
  }

  async duplicateWorkItem(
    workItemId: string,
    userId: string,
    destinationProjectId?: string,
  ) {
    const source = await this.workItemRepository.findWorkItemById(workItemId);
    if (!source) throw new NotFoundException('WorkItem not found');

    const sourceMemberRole =
      await this.workItemRepository.findProjectMemberRole(
        source.projectId,
        userId,
      );
    if (!sourceMemberRole)
      throw new ForbiddenException(
        'Insufficient permissions to access source work item',
      );

    const { cloneData, targetProjectId } =
      await this.cloneHandler.buildCloneData(
        source,
        userId,
        destinationProjectId,
      );
    const cloned = await this.workItemRepository.createWorkItem(cloneData);
    await this.invalidateWorkItemCache(
      targetProjectId,
      cloned.id,
      cloned.cycleId,
    );

    this.eventDispatcher.emitWorkItemDuplicated({
      workItemId: cloned.id,
      actorId: userId,
      projectId: targetProjectId,
    });

    const formatted = formatWorkItem(cloned);
    return {
      workItem: formatted,
      item: formatted,
      message: 'WorkItem duplicated successfully',
    };
  }

  async convertToRootWorkItem(workItemId: string) {
    const item = await this.workItemRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    const updated = await this.workItemRepository.disconnectParentWorkItem(
      item.id,
    );

    await this.invalidateWorkItemCache(item.projectId, item.id, item.cycleId);
    const formatted = formatWorkItem(updated);
    return {
      message: 'WorkItem converted to root work item successfully',
      workItem: formatted,
    };
  }

  getWorkItem = this.getWorkItemById.bind(this);
  bulkUpdateWorkItems = this.bulkUpdate.bind(this);
  bulkDeleteWorkItems = this.bulkDelete.bind(this);
}

export const WorkItemService = CoreService;
export type WorkItemService = CoreService;
