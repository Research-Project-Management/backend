import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Optional,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService, isUuid } from '@/core';
import { CoreRepository } from './core.repository';
import { IdHandler } from './handlers/id.handler';
import { RankHandler } from './handlers/rank.handler';
import { CloneHandler } from './handlers/clone.handler';
import { EventDispatcher } from './handlers/event.dispatcher';
import { BulkHandler } from './handlers/bulk.handler';
import { CreateWorkItemDto } from './dto/create.dto';
import { UpdateWorkItemDto } from './dto/update.dto';
import { QueryWorkItemDto } from './dto/query.dto';
import {
  BulkUpdateWorkItemDto,
  BulkDeleteWorkItemDto,
  ReorderWorkItemDto,
} from './dto/bulk.dto';
import { formatWorkItem, mapPriority } from './utils/work-item.util';
import { isStateCompleted } from '@/modules/work-item/common/utils/state-completion.util';
import { validateHierarchyCycle } from './utils/hierarchy.util';
import {
  WORK_ITEM_REDIS_KEYS,
  invalidateWorkItemCache,
} from '@/modules/work-item/common/constants/redis-keys.constant';
import { Prisma } from '@prisma/client';

interface ProjectStateRecord {
  id: string;
  name: string;
  group: string;
  isDefault?: boolean;
  projectId?: string;
}

@Injectable()
export class CoreService {
  private readonly logger = new Logger(CoreService.name);

  constructor(
    private readonly workItemRepository: CoreRepository,
    private readonly idHandler: IdHandler,
    private readonly rankHandler: RankHandler,
    private readonly cloneHandler: CloneHandler,
    private readonly eventDispatcher: EventDispatcher,
    @Optional()
    private readonly bulkHandler = new BulkHandler(
      workItemRepository,
      eventDispatcher,
    ),
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateCache(projectId: string, workItemId?: string) {
    await invalidateWorkItemCache(this.cache, { projectId, workItemId });
  }

  private async resolveValidAssignees(
    projectId: string,
    rawIds: string[],
  ): Promise<string[]> {
    if (!Array.isArray(rawIds) || rawIds.length === 0) return [];
    const uniqueRawIds = Array.from(new Set(rawIds));
    if (typeof this.workItemRepository.filterProjectMembers === 'function') {
      return this.workItemRepository.filterProjectMembers(
        projectId,
        uniqueRawIds,
      );
    }
    const checked = await Promise.all(
      uniqueRawIds.map(async (uid) => {
        if (!isUuid(uid)) return null;
        const isMember = await this.workItemRepository.isProjectMember(
          projectId,
          uid,
        );
        return isMember ? uid : null;
      }),
    );
    return checked.filter(Boolean) as string[];
  }

  private matchProjectState(
    states: ProjectStateRecord[] | undefined,
    columnId?: string,
    allowFuzzyKeywords = false,
  ): ProjectStateRecord | undefined {
    if (!states || !columnId) return undefined;
    const normalizedCol = columnId.toLowerCase().trim();
    return states.find(
      (s) =>
        s.id === columnId ||
        s.name.toLowerCase() === normalizedCol ||
        s.group.toLowerCase() === normalizedCol ||
        (allowFuzzyKeywords &&
          (s.name.toLowerCase().replace(/[\s_-]+/g, '_') ===
            normalizedCol.replace(/[\s_-]+/g, '_') ||
            (normalizedCol.includes('progress') && s.group === 'started') ||
            (normalizedCol.includes('todo') && s.group === 'unstarted') ||
            (normalizedCol.includes('done') && s.group === 'completed'))),
    );
  }

  private async resolveStateAndCompletion(options: {
    projectId: string;
    states?: ProjectStateRecord[];
    columnId?: string;
    completed?: boolean;
    isCreate: boolean;
    existingStateGroup?: string;
    existingColumnId?: string;
    existingCompleted?: boolean;
  }): Promise<{ columnId?: string; isCompleted?: boolean }> {
    const { projectId, columnId, completed, isCreate } = options;
    let states = options.states;

    if (isCreate) {
      const defaultState = states?.find((s) => s.isDefault) || states?.[0];
      let targetState =
        this.matchProjectState(states, columnId, true) || defaultState;

      if (completed === true && targetState?.group !== 'completed') {
        const completedState = states?.find((s) => s.group === 'completed');
        if (completedState) targetState = completedState;
      } else if (completed === false && targetState?.group === 'completed') {
        if (defaultState && defaultState.group !== 'completed') {
          targetState = defaultState;
        }
      }

      const resolvedCol = targetState
        ? targetState.id
        : columnId || defaultState?.id || 'backlog';
      const isCompleted = targetState
        ? targetState.group === 'completed'
        : isStateCompleted(resolvedCol || '');
      return { columnId: resolvedCol, isCompleted };
    }

    if (columnId !== undefined) {
      let targetState: ProjectStateRecord | null | undefined =
        await this.workItemRepository.findStateById(columnId);
      if (!targetState || targetState.projectId !== projectId) {
        if (!states) {
          const rawProject =
            await this.workItemRepository.findProjectWithColumns(projectId);
          states = rawProject?.states;
        }
        targetState = this.matchProjectState(states, columnId, false);
      }
      const resolvedCol = targetState ? targetState.id : columnId;
      const isCompleted = targetState
        ? targetState.group === 'completed'
        : isStateCompleted(resolvedCol);
      return { columnId: resolvedCol, isCompleted };
    }

    if (completed !== undefined) {
      if (!states) {
        const rawProject =
          await this.workItemRepository.findProjectWithColumns(projectId);
        states = rawProject?.states;
      }
      const isCurrentlyCompleted =
        options.existingStateGroup === 'completed' ||
        options.existingColumnId === 'done' ||
        Boolean(options.existingCompleted);

      if (completed && !isCurrentlyCompleted) {
        const completedState = states?.find((s) => s.group === 'completed');
        return {
          columnId: completedState?.id,
          isCompleted: true,
        };
      }
      if (!completed && isCurrentlyCompleted) {
        const unstartedState =
          states?.find((s) => s.isDefault) ||
          states?.find((s) => s.group === 'unstarted') ||
          states?.[0];
        return {
          columnId: unstartedState?.id,
          isCompleted: false,
        };
      }
      return { isCompleted: completed };
    }

    return {};
  }

  private async buildLabelLookup(
    projectId: string | string[],
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
      lookup.set(l.name, { name: l.name, color: l.color });
    }
    return lookup;
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async getProjectWorkItems(projectId: string, filter?: QueryWorkItemDto) {
    const isUnfiltered =
      !filter ||
      (typeof filter === 'object' && Object.keys(filter).length === 0);
    const cacheKey = WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId);

    const fetchWorkItems = async () => {
      const filterOptions = filter
        ? {
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
      const needsLookup = records.some(
        (r) =>
          Array.isArray(r.labels) &&
          r.labels.length > 0 &&
          (!r.labelAssignments || r.labelAssignments.length === 0),
      );

      let labelLookup = new Map<string, { name: string; color: string }>();
      if (needsLookup) {
        const allLabelNamesOrIds = Array.from(
          new Set(
            records.flatMap((r) => (Array.isArray(r.labels) ? r.labels : [])),
          ),
        );
        labelLookup = await this.buildLabelLookup(
          projectId,
          allLabelNamesOrIds,
        );
      }

      return records.map((record) => formatWorkItem(record, labelLookup));
    };

    if (this.cache && isUnfiltered) {
      const cached = await this.cache.get<Record<string, unknown>[]>(cacheKey);
      if (cached) return cached;
      const result = await fetchWorkItems();
      await this.cache.set(cacheKey, result, 120);
      return result;
    }

    return fetchWorkItems();
  }

  async getUserWorkItems(userId: string, query?: QueryWorkItemDto) {
    const take = query?.limit ? Number(query.limit) : 50;
    const skip =
      query?.page && query?.limit
        ? (Number(query.page) - 1) * Number(query.limit)
        : 0;

    const records = await this.workItemRepository.findWorkItemsByAssignee(
      userId,
      query?.projectId,
      take,
      skip,
    );

    const projectIds = Array.from(new Set(records.map((r) => r.projectId)));
    const allLabelNamesOrIds = Array.from(
      new Set(
        records.flatMap((r) => (Array.isArray(r.labels) ? r.labels : [])),
      ),
    );
    const labelLookup = await this.buildLabelLookup(
      projectIds,
      allLabelNamesOrIds,
    );

    return records.map((record) => formatWorkItem(record, labelLookup));
  }

  async getWorkItemById(workItemId: string) {
    if (this.cache) {
      const cached = await this.cache.get<Record<string, unknown>>(
        WORK_ITEM_REDIS_KEYS.workItem(workItemId),
      );
      if (cached) {
        return {
          ...cached,
          workItem: cached,
          WorkItem: cached,
          item: cached,
        };
      }
    }

    const item = await this.workItemRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');
    if (this.cache) {
      await this.cache.set(WORK_ITEM_REDIS_KEYS.workItem(item.id), item, 60);
    }
    const labelLookup = await this.buildLabelLookup(
      item.projectId,
      item.labels || [],
    );
    const formatted = formatWorkItem(item, labelLookup);
    return {
      ...formatted,
      workItem: formatted,
      WorkItem: formatted,
      item: formatted,
    };
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

    const { columnId: resolvedCol, isCompleted } =
      await this.resolveStateAndCompletion({
        projectId: rawProject.id,
        states: rawProject.states,
        columnId: createWorkItemDto.columnId,
        completed: createWorkItemDto.completed,
        isCreate: true,
      });
    const targetColumn = resolvedCol || 'backlog';

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

    const rawAssigneeIds = Array.isArray(createWorkItemDto.assigneeIds)
      ? createWorkItemDto.assigneeIds
      : createWorkItemDto.assigneeId
        ? [createWorkItemDto.assigneeId]
        : [];
    const validAssigneeIds = await this.resolveValidAssignees(
      rawProject.id,
      rawAssigneeIds,
    );
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
      completed: Boolean(isCompleted),
      relations:
        (createWorkItemDto.relations as unknown as Prisma.InputJsonValue) || [],
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

    await this.invalidateCache(projectId, workItem.id);
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
      parentWorkItemId: parent.id,
    });
  }

  async updateWorkItem(
    workItemId: string,
    updateWorkItemDto: UpdateWorkItemDto,
    userId?: string,
  ) {
    const existing = await this.workItemRepository.findWorkItemById(workItemId);
    if (!existing) throw new NotFoundException('WorkItem not found');

    if (updateWorkItemDto.expectedUpdatedAt) {
      const expectedTime = new Date(
        updateWorkItemDto.expectedUpdatedAt,
      ).getTime();
      const actualTime = new Date(existing.updatedAt).getTime();
      if (
        !isNaN(expectedTime) &&
        !isNaN(actualTime) &&
        Math.abs(actualTime - expectedTime) > 1000
      ) {
        throw new ConflictException(
          'WorkItem has been modified by another user. Please refresh and try again.',
        );
      }
    }

    const parentId =
      updateWorkItemDto.parentWorkItemId !== undefined
        ? updateWorkItemDto.parentWorkItemId
        : updateWorkItemDto.parentId;

    const { columnId: targetColumnId, isCompleted: targetIsCompleted } =
      await this.resolveStateAndCompletion({
        projectId: existing.projectId,
        columnId: updateWorkItemDto.columnId,
        completed: updateWorkItemDto.completed,
        isCreate: false,
        existingStateGroup: existing.state?.group,
        existingColumnId: existing.columnId,
        existingCompleted: existing.completed,
      });

    let assigneeUpdate: Prisma.WorkItemUpdateInput['assignee'] | undefined;
    if (updateWorkItemDto.assigneeId !== undefined) {
      if (!updateWorkItemDto.assigneeId) {
        assigneeUpdate = { disconnect: true };
      } else if (isUuid(updateWorkItemDto.assigneeId)) {
        const isMember = await this.workItemRepository.isProjectMember(
          existing.projectId,
          updateWorkItemDto.assigneeId,
        );
        assigneeUpdate = isMember
          ? { connect: { id: updateWorkItemDto.assigneeId } }
          : { disconnect: true };
      }
    }

    let validAssigneeIds: string[] | undefined;
    if (updateWorkItemDto.assigneeIds !== undefined) {
      validAssigneeIds = Array.isArray(updateWorkItemDto.assigneeIds)
        ? await this.resolveValidAssignees(
            existing.projectId,
            updateWorkItemDto.assigneeIds,
          )
        : [];
    }

    let parentUpdate: Prisma.WorkItemUpdateInput['parentWorkItem'] | undefined;
    if (parentId !== undefined) {
      if (!parentId) {
        parentUpdate = { disconnect: true };
      } else if (parentId === workItemId || parentId === existing.id) {
        throw new BadRequestException(
          'A work item cannot be set as its own parent',
        );
      } else {
        const parent = await this.workItemRepository.findWorkItemById(parentId);
        if (parent && parent.projectId === existing.projectId) {
          if (parent.id === workItemId || parent.id === existing.id) {
            throw new BadRequestException(
              'A work item cannot be set as its own parent',
            );
          }
          await validateHierarchyCycle(existing.id, parent, (id) =>
            this.workItemRepository.findWorkItemById(id),
          );
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
        relations:
          updateWorkItemDto.relations as unknown as Prisma.InputJsonValue,
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

    await this.invalidateCache(existing.projectId, existing.id);

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
    await this.invalidateCache(item.projectId, item.id);
    this.eventDispatcher.emitWorkItemDeleted({
      workItemId: item.id,
      actorId: userId,
      projectId: item.projectId,
    });
    return { message: 'WorkItem deleted successfully' };
  }

  async reorderWorkItem(
    workItemId: string,
    reorderDto: ReorderWorkItemDto,
    userId?: string,
  ) {
    const item = await this.workItemRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    const targetColumn = reorderDto.columnId || item.columnId;
    const targetRank =
      typeof reorderDto.rank === 'number' ? reorderDto.rank : 0;

    const columnItems = await this.workItemRepository.findColumnWorkItems(
      item.projectId,
      targetColumn,
    );

    const updates = this.rankHandler.calculateReorder(
      columnItems,
      item.id,
      targetColumn,
      targetRank,
      isStateCompleted,
      item,
    );

    if (updates.length > 0) {
      await this.workItemRepository.updateWorkItemsRank(updates);
      await this.invalidateCache(item.projectId);
    }

    this.eventDispatcher.emitWorkItemReordered({
      workItemId: item.id,
      projectId: item.projectId,
      columnId: targetColumn,
      rank: targetRank,
      actorId: userId,
    });

    return { message: 'WorkItem reordered successfully' };
  }

  async bulkUpdate(
    projectId: string,
    bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
    userId?: string,
  ) {
    return this.bulkHandler.bulkUpdate(
      projectId,
      bulkUpdateWorkItemDto,
      userId,
      (projId) => this.invalidateCache(projId),
    );
  }

  async bulkDelete(
    projectId: string,
    bulkDeleteWorkItemDto: BulkDeleteWorkItemDto,
    userId?: string,
  ) {
    return this.bulkHandler.bulkDelete(
      projectId,
      bulkDeleteWorkItemDto,
      userId,
      (projId) => this.invalidateCache(projId),
    );
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
    if (!sourceMemberRole) {
      throw new ForbiddenException(
        'Insufficient permissions to access source work item',
      );
    }

    const { cloneData, targetProjectId } =
      await this.cloneHandler.buildCloneData(
        source,
        userId,
        destinationProjectId,
      );
    const cloned = await this.workItemRepository.createWorkItem(cloneData);
    await this.invalidateCache(targetProjectId, cloned.id);

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

    await this.invalidateCache(item.projectId, item.id);
    const formatted = formatWorkItem(updated);
    return {
      message: 'WorkItem converted to root work item successfully',
      workItem: formatted,
    };
  }

  async convertSubItemToRoot(workItemId: string) {
    return this.convertToRootWorkItem(workItemId);
  }

  async getWorkItemAnalytics(projectId: string) {
    const items = await this.getProjectWorkItems(projectId);
    const byStateGroup: Record<string, number> = {
      backlog: 0,
      unstarted: 0,
      started: 0,
      completed: 0,
      cancelled: 0,
    };
    const byPriority: Record<string, number> = {
      none: 0,
      low: 0,
      medium: 0,
      high: 0,
      urgent: 0,
    };

    let completedCount = 0;
    let overdueCount = 0;
    let totalTimeSpent = 0;
    const now = Date.now();

    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown>;
      const group = String(item.stateGroup || 'unstarted').toLowerCase();
      byStateGroup[group] = (byStateGroup[group] || 0) + 1;

      const prio = String(item.priority || 'none').toLowerCase();
      byPriority[prio] = (byPriority[prio] || 0) + 1;

      const isDone = Boolean(item.completed) || group === 'completed';
      if (isDone) {
        completedCount += 1;
      } else if (
        group !== 'cancelled' &&
        item.dueDate &&
        new Date(String(item.dueDate)).getTime() < now
      ) {
        overdueCount += 1;
      }

      if (typeof item.timeSpent === 'number' && !isNaN(item.timeSpent)) {
        totalTimeSpent += item.timeSpent;
      }
    }

    const total = items.length;
    const completionRate =
      total > 0 ? Math.round((completedCount / total) * 100) : 0;

    return {
      total,
      completed: completedCount,
      overdue: overdueCount,
      completionRate,
      totalTimeSpent: Number(totalTimeSpent.toFixed(2)),
      byStateGroup,
      byPriority,
    };
  }
}

export const WorkItemService = CoreService;
export type WorkItemService = CoreService;
