import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
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
import { Prisma } from '@prisma/client';

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

  private async buildLabelLookup(
    projectId: string,
    labelIds: string[],
  ): Promise<Map<string, { name: string; color: string }>> {
    const lookup = new Map<string, { name: string; color: string }>();
    if (!labelIds.length) return lookup;
    const labels = await this.workItemRepository.findLabelsByIds(
      projectId,
      labelIds,
    );
    for (const l of labels) {
      lookup.set(l.id, { name: l.name, color: l.color });
    }
    return lookup;
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
                columnId: filter.columnId || filter.state,
                stateGroup: filter.stateGroup,
                priority: filter.priority,
                assigneeId: filter.assigneeId || filter.assignees,
                labels: filter.labels,
                createdById: filter.createdById || filter.authorId,
                parentWorkItemId: filter.parentWorkItemId,
                dueDate: filter.dueDate,
                startDate: filter.startDate,
                orderBy: filter.orderBy,
                orderDirection: filter.orderDirection,
                completed: filter.completed,
                archived: filter.archived,
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
      const allLabelIds = records.flatMap((r) => r.labels || []);
      const labelLookup = await this.buildLabelLookup(projectId, allLabelIds);
      return records.map((r) => formatWorkItem(r, labelLookup)).filter(Boolean);
    };

    if (this.cache && (isUnfiltered || isSimpleCycle)) {
      const workItems = await this.cache.wrap(cacheKey, fetchWorkItems, 300);
      return { workItems };
    }
    const workItems = await fetchWorkItems();
    return { workItems };
  }

  async getUserWorkItems(userId: string, query?: QueryWorkItemDto) {
    const limit = query?.limit ? Number(query.limit) : 50;
    const offset =
      query?.page && query?.limit ? (query.page - 1) * query.limit : 0;
    const records = await this.workItemRepository.findWorkItemsByAssignee(
      userId,
      query?.projectId,
      limit,
      offset,
    );
    const allLabelIds = records.flatMap((r) => r.labels || []);
    const projectId =
      query?.projectId || (records[0]?.projectId as string | undefined);
    const labelLookup = projectId
      ? await this.buildLabelLookup(projectId, allLabelIds)
      : new Map<string, { id: string; name: string; color: string }>();
    const workItems = records
      .map((r) => formatWorkItem(r, labelLookup))
      .filter(Boolean);
    return { workItems, data: workItems, total: workItems.length };
  }

  async getWorkItemById(workItemId: string) {
    if (this.cache) {
      const cached = await this.cache.get<any>(
        WORK_ITEM_REDIS_KEYS.workItem(workItemId),
      );
      if (cached) {
        const labelLookup = await this.buildLabelLookup(
          cached.projectId,
          cached.labels || [],
        );
        const formatted = formatWorkItem(cached, labelLookup);
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
    const labelLookup = await this.buildLabelLookup(
      item.projectId,
      item.labels || [],
    );
    const formatted = formatWorkItem(item, labelLookup);
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
    const normalizedCol = (createWorkItemDto.columnId || '')
      .toLowerCase()
      .trim();
    let targetState =
      rawProject.states?.find(
        (s) =>
          s.id === createWorkItemDto.columnId ||
          s.name.toLowerCase() === normalizedCol ||
          s.group.toLowerCase() === normalizedCol ||
          s.name.toLowerCase().replace(/[\s_-]+/g, '_') ===
            normalizedCol.replace(/[\s_-]+/g, '_') ||
          (normalizedCol.includes('progress') && s.group === 'started') ||
          (normalizedCol.includes('todo') && s.group === 'unstarted') ||
          (normalizedCol.includes('done') && s.group === 'completed'),
      ) || defaultState;

    if (
      createWorkItemDto.completed === true &&
      targetState?.group !== 'completed'
    ) {
      const completedState = rawProject.states?.find(
        (s) => s.group === 'completed',
      );
      if (completedState) {
        targetState = completedState;
      }
    } else if (
      createWorkItemDto.completed === false &&
      targetState?.group === 'completed'
    ) {
      if (defaultState && defaultState.group !== 'completed') {
        targetState = defaultState;
      }
    }

    const targetColumn = targetState
      ? targetState.id
      : createWorkItemDto.columnId || defaultState?.id || 'backlog';
    const isCompleted = targetState
      ? targetState.group === 'completed'
      : isStateCompleted(targetColumn || '');

    const columnCount = await this.workItemRepository.countColumnWorkItems(
      rawProject.id,
      targetColumn,
    );
    const { identifier, sequenceNumber } = await this.idHandler.nextIdentifier(
      rawProject.id,
    );

    const parentId =
      createWorkItemDto.parentWorkItemId ?? createWorkItemDto.parentId;
    let validParentId: string | null = null;
    if (parentId && isUuid(parentId)) {
      const parentItem =
        await this.workItemRepository.findWorkItemById(parentId);
      if (parentItem && parentItem.projectId === rawProject.id) {
        validParentId = parentItem.id;
      }
    }

    let validCycleId: string | null = null;
    if (createWorkItemDto.cycleId && isUuid(createWorkItemDto.cycleId)) {
      const cycle = await this.workItemRepository.findCycleById(
        createWorkItemDto.cycleId,
      );
      if (cycle && cycle.projectId === rawProject.id && !cycle.deletedAt) {
        validCycleId = cycle.id;
      }
    }

    const rawAssigneeIds = Array.isArray(createWorkItemDto.assigneeIds)
      ? createWorkItemDto.assigneeIds
      : createWorkItemDto.assigneeId
        ? [createWorkItemDto.assigneeId]
        : [];
    const validAssigneeIds = (
      await Promise.all(
        rawAssigneeIds.map(async (uid) => {
          if (!isUuid(uid)) return null;
          const isMember = await this.workItemRepository.isProjectMember(
            rawProject.id,
            uid,
          );
          return isMember ? uid : null;
        }),
      )
    ).filter(Boolean) as string[];
    const validAssigneeId = validAssigneeIds[0] || null;

    const workItem = await this.workItemRepository.createWorkItem({
      title: createWorkItemDto.title,
      content: createWorkItemDto.content || createWorkItemDto.description || '',
      rank: createWorkItemDto.rank ?? columnCount,
      priority: mapPriority(createWorkItemDto.priority),
      identifier,
      sequenceNumber,
      labels: Array.isArray(createWorkItemDto.labels)
        ? createWorkItemDto.labels.filter(
            (l) => typeof l === 'string' && l.trim().length > 0,
          )
        : [],
      completed: isCompleted,
      relations: createWorkItemDto.relations || [],
      startDate: createWorkItemDto.startDate
        ? new Date(createWorkItemDto.startDate)
        : null,
      dueDate: createWorkItemDto.dueDate
        ? new Date(createWorkItemDto.dueDate)
        : null,
      timeSpent: createWorkItemDto.timeSpent || 0,
      assigneeIds: validAssigneeIds,
      project: { connect: { id: rawProject.id } },
      author: { connect: { id: authorId } },
      ...(targetColumn ? { state: { connect: { id: targetColumn } } } : {}),
      ...(validAssigneeId
        ? { assignee: { connect: { id: validAssigneeId } } }
        : {}),
      ...(validCycleId ? { cycle: { connect: { id: validCycleId } } } : {}),
      ...(validParentId
        ? { parentWorkItem: { connect: { id: validParentId } } }
        : {}),
    });

    if (createWorkItemDto.attachments) {
      await this.workItemRepository.saveInitialAttachments(
        workItem.id,
        projectId,
        authorId,
        createWorkItemDto.attachments,
      );
    }

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
    const labelLookup = await this.buildLabelLookup(
      workItem.projectId,
      workItem.labels || [],
    );
    const formatted = formatWorkItem(
      {
        ...workItem,
        ...(createWorkItemDto.attachments
          ? { attachments: createWorkItemDto.attachments }
          : {}),
      },
      labelLookup,
    );
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

    const parentId =
      updateWorkItemDto.parentWorkItemId !== undefined
        ? updateWorkItemDto.parentWorkItemId
        : updateWorkItemDto.parentId;

    let targetIsCompleted: boolean | undefined;
    let targetColumnId: string | undefined;
    if (updateWorkItemDto.columnId !== undefined) {
      let targetState = await this.workItemRepository.findStateById(
        updateWorkItemDto.columnId,
      );
      if (!targetState || targetState.projectId !== existing.projectId) {
        const rawProject = await this.workItemRepository.findProjectWithColumns(
          existing.projectId,
        );
        targetState = rawProject?.states?.find(
          (s) =>
            s.id === updateWorkItemDto.columnId ||
            s.name.toLowerCase() ===
              updateWorkItemDto.columnId?.toLowerCase() ||
            s.group.toLowerCase() === updateWorkItemDto.columnId?.toLowerCase(),
        ) as any;
      }
      targetColumnId = targetState
        ? targetState.id
        : updateWorkItemDto.columnId;
      targetIsCompleted = targetState
        ? targetState.group === 'completed'
        : isStateCompleted(targetColumnId);
    } else if (updateWorkItemDto.completed !== undefined) {
      const rawProject = await this.workItemRepository.findProjectWithColumns(
        existing.projectId,
      );
      const isCurrentlyCompleted =
        existing.state?.group === 'completed' ||
        existing.columnId === 'done' ||
        Boolean(existing.completed);

      if (updateWorkItemDto.completed && !isCurrentlyCompleted) {
        const completedState = rawProject?.states?.find(
          (s) => s.group === 'completed',
        );
        if (completedState) {
          targetColumnId = completedState.id;
        }
        targetIsCompleted = true;
      } else if (!updateWorkItemDto.completed && isCurrentlyCompleted) {
        const unstartedState =
          rawProject?.states?.find((s) => s.isDefault) ||
          rawProject?.states?.find((s) => s.group === 'unstarted') ||
          rawProject?.states?.[0];
        if (unstartedState) {
          targetColumnId = unstartedState.id;
        }
        targetIsCompleted = false;
      } else {
        targetIsCompleted = updateWorkItemDto.completed;
      }
    }

    let cycleUpdate: Prisma.WorkItemUpdateInput['cycle'] | undefined;
    if (updateWorkItemDto.cycleId !== undefined) {
      if (!updateWorkItemDto.cycleId) {
        cycleUpdate = { disconnect: true };
      } else if (isUuid(updateWorkItemDto.cycleId)) {
        const cycle = await this.workItemRepository.findCycleById(
          updateWorkItemDto.cycleId,
        );
        if (
          cycle &&
          cycle.projectId === existing.projectId &&
          !cycle.deletedAt
        ) {
          cycleUpdate = { connect: { id: cycle.id } };
        } else {
          cycleUpdate = { disconnect: true };
        }
      }
    }

    let assigneeUpdate: Prisma.WorkItemUpdateInput['assignee'] | undefined;
    if (updateWorkItemDto.assigneeId !== undefined) {
      if (!updateWorkItemDto.assigneeId) {
        assigneeUpdate = { disconnect: true };
      } else if (isUuid(updateWorkItemDto.assigneeId)) {
        const isMember = await this.workItemRepository.isProjectMember(
          existing.projectId,
          updateWorkItemDto.assigneeId,
        );
        if (isMember) {
          assigneeUpdate = {
            connect: { id: updateWorkItemDto.assigneeId },
          };
        } else {
          assigneeUpdate = { disconnect: true };
        }
      }
    }

    let validAssigneeIds: string[] | undefined;
    if (updateWorkItemDto.assigneeIds !== undefined) {
      if (Array.isArray(updateWorkItemDto.assigneeIds)) {
        const filtered = (
          await Promise.all(
            updateWorkItemDto.assigneeIds.map(async (uid) => {
              if (!isUuid(uid)) return null;
              const isMember = await this.workItemRepository.isProjectMember(
                existing.projectId,
                uid,
              );
              return isMember ? uid : null;
            }),
          )
        ).filter(Boolean) as string[];
        validAssigneeIds = filtered;
      } else {
        validAssigneeIds = [];
      }
    }

    let parentUpdate: Prisma.WorkItemUpdateInput['parentWorkItem'] | undefined;
    if (parentId !== undefined) {
      if (!parentId) {
        parentUpdate = { disconnect: true };
      } else if (isUuid(parentId) && parentId !== workItemId) {
        const parent = await this.workItemRepository.findWorkItemById(parentId);
        if (
          parent &&
          parent.projectId === existing.projectId &&
          parent.id !== workItemId
        ) {
          // Guard against circular hierarchy (setting a descendant or cyclical ancestor as parent)
          let curr: any = parent;
          let isCycle = false;
          const visited = new Set<string>([workItemId]);
          while (curr && curr.parentWorkItemId) {
            if (visited.has(curr.parentWorkItemId)) {
              isCycle = true;
              break;
            }
            visited.add(curr.parentWorkItemId);
            curr = await this.workItemRepository.findWorkItemById(
              curr.parentWorkItemId,
            );
          }
          if (isCycle) {
            throw new BadRequestException(
              'Cannot set a descendant or cyclical ancestor as the parent work item',
            );
          }
          parentUpdate = { connect: { id: parent.id } };
        } else {
          parentUpdate = { disconnect: true };
        }
      }
    }

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
      ...(targetColumnId !== undefined && {
        state: { connect: { id: targetColumnId } },
        completed: targetIsCompleted,
      }),
      ...(targetColumnId === undefined &&
        targetIsCompleted !== undefined && {
          completed: targetIsCompleted,
        }),
      ...(updateWorkItemDto.priority !== undefined && {
        priority: mapPriority(updateWorkItemDto.priority),
      }),
      ...(updateWorkItemDto.rank !== undefined && {
        rank: updateWorkItemDto.rank,
      }),
      ...(updateWorkItemDto.labels !== undefined && {
        labels: Array.isArray(updateWorkItemDto.labels)
          ? updateWorkItemDto.labels.filter(
              (l) => typeof l === 'string' && l.trim().length > 0,
            )
          : [],
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
      ...(assigneeUpdate !== undefined && { assignee: assigneeUpdate }),
      ...(cycleUpdate !== undefined && { cycle: cycleUpdate }),
      ...(parentUpdate !== undefined && { parentWorkItem: parentUpdate }),
      ...(validAssigneeIds !== undefined && {
        assigneeIds: validAssigneeIds,
      }),
    });

    if (updateWorkItemDto.attachments !== undefined) {
      if (typeof this.workItemRepository.syncAttachments === 'function') {
        await this.workItemRepository.syncAttachments(
          existing.id,
          existing.projectId,
          userId,
          updateWorkItemDto.attachments,
        );
      }
    }

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
    const labelLookup = await this.buildLabelLookup(
      updated.projectId,
      updated.labels || [],
    );
    const formatted = formatWorkItem(updated, labelLookup);
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

    const targetState =
      await this.workItemRepository.findStateById(targetColumn);
    const isTargetDone = targetState
      ? targetState.group === 'completed'
      : isStateCompleted(targetColumn);

    const updates = this.rankHandler.calculateReorder(
      columnItems,
      item.id,
      targetColumn,
      targetRank,
      () => isTargetDone,
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

    const rawProject =
      await this.workItemRepository.findProjectWithColumns(projectId);
    const canonicalProjectId = rawProject?.id || projectId;

    const data: any = {};
    if (payload.columnId !== undefined) {
      const targetState = rawProject?.states?.find(
        (s) =>
          s.id === payload.columnId ||
          s.name.toLowerCase() === payload.columnId?.toLowerCase() ||
          s.group.toLowerCase() === payload.columnId?.toLowerCase(),
      );
      data.columnId = targetState ? targetState.id : payload.columnId;
      data.completed = targetState
        ? targetState.group === 'completed'
        : isStateCompleted(data.columnId);
    } else if (payload.completed !== undefined) {
      if (payload.completed) {
        const completedState = rawProject?.states?.find(
          (s) => s.group === 'completed',
        );
        if (completedState) {
          data.columnId = completedState.id;
        }
        data.completed = true;
      } else {
        const defaultState =
          rawProject?.states?.find((s) => s.isDefault) ||
          rawProject?.states?.find((s) => s.group === 'unstarted') ||
          rawProject?.states?.[0];
        if (defaultState) {
          data.columnId = defaultState.id;
        }
        data.completed = false;
      }
    }

    if (payload.assigneeId !== undefined) {
      if (!payload.assigneeId) {
        data.assigneeId = null;
      } else if (isUuid(payload.assigneeId)) {
        const isMember = await this.workItemRepository.isProjectMember(
          canonicalProjectId,
          payload.assigneeId,
        );
        if (isMember) {
          data.assigneeId = payload.assigneeId;
        }
      }
    }

    if (payload.priority !== undefined)
      data.priority = mapPriority(payload.priority);

    if (payload.cycleId !== undefined) {
      if (!payload.cycleId) {
        data.cycleId = null;
      } else if (isUuid(payload.cycleId)) {
        const cycle = await this.workItemRepository.findCycleById(
          payload.cycleId,
        );
        if (
          cycle &&
          cycle.projectId === canonicalProjectId &&
          !cycle.deletedAt
        ) {
          data.cycleId = cycle.id;
        }
      }
    }

    if (payload.dueDate !== undefined)
      data.dueDate = payload.dueDate ? new Date(payload.dueDate) : null;

    if (payload.startDate !== undefined)
      data.startDate = payload.startDate ? new Date(payload.startDate) : null;

    if (payload.clearLabels === true) {
      data.labels = [];
    } else if (payload.labels !== undefined && Array.isArray(payload.labels)) {
      data.labels = payload.labels.filter(
        (l: any) => typeof l === 'string' && l.trim().length > 0,
      );
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
    let effectiveProjectId = projectId;
    const rawIds =
      bulkDeleteWorkItemDto.workItemIds || bulkDeleteWorkItemDto.ids || [];
    if (!effectiveProjectId && rawIds.length > 0) {
      const firstItem = await this.workItemRepository.findWorkItemById(
        rawIds[0],
      );
      if (firstItem) {
        effectiveProjectId = firstItem.projectId;
      }
    }
    if (!effectiveProjectId) {
      throw new BadRequestException('Project ID is required for bulk deletion');
    }
    const result = await this.workItemRepository.bulkDeleteWorkItems(
      effectiveProjectId,
      rawIds,
    );
    await this.invalidateWorkItemCache(effectiveProjectId);
    this.eventDispatcher.emitBulkDeleted(effectiveProjectId, userId);
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
