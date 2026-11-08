import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService, isUuid } from '@/core';
import { CoreRepository } from './core.repository';
import { IdHandler } from './handlers/id.handler';
import { RankHandler } from './handlers/rank.handler';
import { CloneHandler } from './handlers/clone.handler';
import { EventHandler } from './handlers/event.handler';
import { BulkHandler } from './handlers/bulk.handler';
import {
  CreateWorkItemDto,
  UpdateWorkItemDto,
  QueryWorkItemDto,
  BulkUpdateWorkItemDto,
  BulkDeleteWorkItemDto,
  ReorderWorkItemDto,
} from './dto/core.dto';
import {
  formatWorkItem,
  mapPriority,
  calculateWorkItemAnalytics,
  validateHierarchyCycle,
} from './utils/core.util';
import {
  isStateCompleted,
  resolveStateAndCompletionTransition,
  type StateMinimalDescriptor,
} from '@/modules/project/work-item/state/utils/state.util';
import {
  WORK_ITEM_REDIS_KEYS,
  invalidateWorkItemCache,
} from '@/modules/project/work-item/common/constants/redis.constant';
import { Prisma } from '@prisma/client';
import { ResourceAccessPolicy, Role } from '@/modules/project/access';

@Injectable()
export class CoreService {
  private readonly bulkHandler: BulkHandler;

  constructor(
    private readonly coreRepository: CoreRepository,
    private readonly idHandler: IdHandler,
    private readonly rankHandler: RankHandler,
    private readonly cloneHandler: CloneHandler,
    private readonly eventHandler: EventHandler,
    @Optional() bulkHandler?: BulkHandler,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly resourcePolicy?: ResourceAccessPolicy,
  ) {
    this.bulkHandler =
      bulkHandler ||
      new BulkHandler(
        this.coreRepository,
        this.eventHandler,
        this.cache,
      );
  }

  private async invalidateCache(projectId: string, workItemId?: string) {
    await invalidateWorkItemCache(this.cache, { projectId, workItemId });
  }

  private async resolveValidAssignees(
    projectId: string,
    rawIds: string[],
  ): Promise<string[]> {
    if (!Array.isArray(rawIds) || rawIds.length === 0) return [];
    const uniqueRawIds = Array.from(new Set(rawIds));
    if (typeof this.coreRepository.filterProjectMembers === 'function') {
      return this.coreRepository.filterProjectMembers(
        projectId,
        uniqueRawIds,
      );
    }
    const checked = await Promise.all(
      uniqueRawIds.map(async (uid) => {
        if (!isUuid(uid)) return null;
        const isMember = await this.coreRepository.isProjectMember(
          projectId,
          uid,
        );
        return isMember ? uid : null;
      }),
    );
    return checked.filter(Boolean) as string[];
  }

  private async resolveStateAndCompletion(options: {
    projectId: string;
    states?: StateMinimalDescriptor[];
    columnId?: string;
    completed?: boolean;
    isCreate: boolean;
    existingStateGroup?: string;
    existingColumnId?: string;
    existingCompleted?: boolean;
  }): Promise<{ columnId?: string; isCompleted?: boolean }> {
    return resolveStateAndCompletionTransition({
      ...options,
      findStateById: (stateId, projId) =>
        this.coreRepository.findStateById(stateId, projId),
      loadProjectStates: async (projId) => {
        const rawProject =
          await this.coreRepository.findProjectWithStates(projId);
        return rawProject?.states;
      },
    });
  }

  private async buildLabelLookup(
    projectId: string | string[],
    labelIds: string[],
  ): Promise<Map<string, { name: string; color: string }>> {
    const lookup = new Map<string, { name: string; color: string }>();
    if (!labelIds.length) return lookup;
    const labels = await this.coreRepository.findLabelsByIds(
      projectId,
      labelIds,
    );
    for (const l of labels) {
      lookup.set(l.id, { name: l.name, color: l.color });
      lookup.set(l.name, { name: l.name, color: l.color });
    }
    return lookup;
  }

  private async resolveLabelTokensToNames(
    projectId: string,
    rawLabels: string[],
  ): Promise<string[]> {
    const unique = Array.from(new Set(rawLabels.filter(Boolean)));
    if (unique.length === 0) return [];
    const hasUuid = unique.some((l) => isUuid(l));
    if (
      !hasUuid ||
      typeof this.coreRepository.findLabelsByIds !== 'function'
    ) {
      return unique;
    }
    try {
      const lookup = await this.buildLabelLookup(projectId, unique);
      return Array.from(
        new Set(unique.map((token) => lookup.get(token)?.name || token)),
      );
    } catch {
      return unique;
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async getProjectWorkItems(projectId: string, filter?: QueryWorkItemDto) {
    const isUnfiltered =
      !filter ||
      (typeof filter === 'object' && Object.keys(filter).length === 0);
    const cacheKey = WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId);

    const fetchWorkItems = async () => {
      let resolvedFilterLabels: string | string[] | undefined = filter?.labels;
      if (filter?.labels) {
        const rawTokens = Array.isArray(filter.labels)
          ? filter.labels
          : [filter.labels];
        const expanded = await this.resolveLabelTokensToNames(
          projectId,
          rawTokens,
        );
        resolvedFilterLabels = Array.from(new Set([...rawTokens, ...expanded]));
      }

      const filterOptions = filter
        ? {
            workItems: filter.workItems || filter.ids,
            columnId: filter.columnId || filter.state,
            stateGroup: filter.stateGroup,
            priority: filter.priority,
            assigneeId: filter.assigneeId || filter.assignees,
            subscribers: filter.subscribers,
            mentions: filter.mentions,
            labels: resolvedFilterLabels,
            attach: filter.attach,
            createdById: filter.createdById || filter.authorId,
            parentWorkItemId:
              filter.parentWorkItemId !== undefined
                ? filter.parentWorkItemId
                : filter.parent,
            dueDate: filter.dueDate,
            startDate: filter.startDate,
            createdAt: filter.createdAt,
            updatedAt: filter.updatedAt,
            orderBy: filter.orderBy || filter.sort,
            orderDirection: filter.orderDirection || filter.order,
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

      const records = await this.coreRepository.findProjectWorkItems(
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

    const records = await this.coreRepository.findWorkItemsByAssignee(
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
          item: cached,
        };
      }
    }

    const item = await this.coreRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');
    const labelLookup = await this.buildLabelLookup(
      item.projectId,
      item.labels || [],
    );
    const formatted = formatWorkItem(item, labelLookup);
    if (this.cache) {
      await this.cache.set(
        WORK_ITEM_REDIS_KEYS.workItem(item.id),
        formatted,
        60,
      );
    }
    return {
      ...formatted,
      workItem: formatted,
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
      await this.coreRepository.findProjectWithStates(projectId);
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

    const columnCount = await this.coreRepository.countStateWorkItems(
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
        await this.coreRepository.findWorkItemById(parentId);
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

    const rawCreateLabels = [
      ...(Array.isArray(createWorkItemDto.labels)
        ? createWorkItemDto.labels
        : []),
      ...(Array.isArray(createWorkItemDto.labelIds)
        ? createWorkItemDto.labelIds
        : []),
    ]
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      .map((l) => l.trim());
    const resolvedCreateLabels = await this.resolveLabelTokensToNames(
      rawProject.id,
      rawCreateLabels,
    );

    const workItem = await this.coreRepository.createWorkItem({
      title: createWorkItemDto.title,
      content: createWorkItemDto.content || createWorkItemDto.description || '',
      rank: createWorkItemDto.rank ?? columnCount,
      priority: mapPriority(createWorkItemDto.priority),
      identifier,
      sequenceNumber,
      labels: resolvedCreateLabels,
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
      await this.coreRepository.saveInitialAttachments(
        workItem.id,
        projectId,
        authorId,
        createWorkItemDto.attachments,
      );
    }

    await this.invalidateCache(projectId, workItem.id);
    if (validParentId) {
      await this.invalidateCache(projectId, validParentId);
    }
    this.eventHandler.emitWorkItemCreated({
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
      await this.coreRepository.findWorkItemById(parentWorkItemId);
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
    const existing = await this.coreRepository.findWorkItemById(workItemId);
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
    let validAssigneeIds: string[] | undefined;

    if (updateWorkItemDto.assigneeIds !== undefined) {
      validAssigneeIds = Array.isArray(updateWorkItemDto.assigneeIds)
        ? await this.resolveValidAssignees(
            existing.projectId,
            updateWorkItemDto.assigneeIds,
          )
        : [];
      if (updateWorkItemDto.assigneeId === undefined) {
        const primaryId = validAssigneeIds[0] ?? null;
        assigneeUpdate = primaryId
          ? { connect: { id: primaryId } }
          : { disconnect: true };
      }
    }

    if (updateWorkItemDto.assigneeId !== undefined) {
      if (!updateWorkItemDto.assigneeId) {
        assigneeUpdate = { disconnect: true };
        if (validAssigneeIds === undefined) {
          validAssigneeIds = [];
        }
      } else if (isUuid(updateWorkItemDto.assigneeId)) {
        const isMember = await this.coreRepository.isProjectMember(
          existing.projectId,
          updateWorkItemDto.assigneeId,
        );
        assigneeUpdate = isMember
          ? { connect: { id: updateWorkItemDto.assigneeId } }
          : { disconnect: true };
        if (validAssigneeIds === undefined) {
          validAssigneeIds = isMember ? [updateWorkItemDto.assigneeId] : [];
        } else if (
          isMember &&
          !validAssigneeIds.includes(updateWorkItemDto.assigneeId)
        ) {
          validAssigneeIds = [
            updateWorkItemDto.assigneeId,
            ...validAssigneeIds,
          ];
        }
      }
    }

    let resolvedUpdateLabels: string[] | undefined;
    if (
      updateWorkItemDto.labels !== undefined ||
      updateWorkItemDto.labelIds !== undefined
    ) {
      const rawUpdateLabels = [
        ...(Array.isArray(updateWorkItemDto.labels)
          ? updateWorkItemDto.labels
          : []),
        ...(Array.isArray(updateWorkItemDto.labelIds)
          ? updateWorkItemDto.labelIds
          : []),
      ]
        .filter(
          (l): l is string => typeof l === 'string' && l.trim().length > 0,
        )
        .map((l) => l.trim());
      resolvedUpdateLabels = await this.resolveLabelTokensToNames(
        existing.projectId,
        rawUpdateLabels,
      );
    }

    let parentUpdate: Prisma.WorkItemUpdateInput['parentWorkItem'] | undefined;
    let resolvedNewParentId: string | null = null;
    if (parentId !== undefined) {
      if (!parentId) {
        parentUpdate = { disconnect: true };
      } else if (parentId === workItemId || parentId === existing.id) {
        throw new BadRequestException(
          'A work item cannot be set as its own parent',
        );
      } else {
        const parent = await this.coreRepository.findWorkItemById(parentId);
        if (parent && parent.projectId === existing.projectId) {
          if (parent.id === workItemId || parent.id === existing.id) {
            throw new BadRequestException(
              'A work item cannot be set as its own parent',
            );
          }
          await validateHierarchyCycle(existing.id, parent, async (id) => {
            if (
              typeof this.coreRepository.findWorkItemParentNode ===
              'function'
            ) {
              const stub = await this.coreRepository
                .findWorkItemParentNode(id)
                .catch(() => null);
              if (stub) return stub;
            }
            return this.coreRepository.findWorkItemById(id);
          });
          parentUpdate = { connect: { id: parent.id } };
          resolvedNewParentId = parent.id;
        } else {
          parentUpdate = { disconnect: true };
        }
      }
    }

    const updated = await this.coreRepository.updateWorkItem(existing.id, {
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
      ...(resolvedUpdateLabels !== undefined && {
        labels: resolvedUpdateLabels,
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
      if (typeof this.coreRepository.syncAttachments === 'function') {
        await this.coreRepository.syncAttachments(
          existing.id,
          existing.projectId,
          userId,
          updateWorkItemDto.attachments,
        );
      }
    }

    await this.invalidateCache(existing.projectId, existing.id);
    if (existing.parentWorkItemId) {
      await this.invalidateCache(existing.projectId, existing.parentWorkItemId);
    }
    if (
      resolvedNewParentId &&
      resolvedNewParentId !== existing.parentWorkItemId
    ) {
      await this.invalidateCache(existing.projectId, resolvedNewParentId);
    }

    this.eventHandler.dispatchUpdateEvents(
      existing,
      updateWorkItemDto,
      userId,
      targetColumnId,
    );
    const labelLookup = await this.buildLabelLookup(
      updated.projectId,
      updated.labels || [],
    );
    const formatted = formatWorkItem(updated, labelLookup);
    return { workItem: formatted, item: formatted };
  }

  async deleteWorkItem(workItemId: string, userId?: string) {
    const item = await this.coreRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    if (userId && this.resourcePolicy) {
      const memberRole = await this.coreRepository
        .findProjectMemberRole(item.projectId, userId)
        .catch(() => null);
      if (memberRole) {
        this.resourcePolicy.assertCanModifyWorkItem(
          { userId, role: memberRole as Role },
          { id: item.id, createdById: item.createdById },
          'delete',
        );
      }
    }

    await this.coreRepository.softDeleteWorkItem(item.id);
    await this.invalidateCache(item.projectId, item.id);
    if (item.parentWorkItemId) {
      await this.invalidateCache(item.projectId, item.parentWorkItemId);
    }
    this.eventHandler.emitWorkItemDeleted({
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
    const item = await this.coreRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    const targetColumn = reorderDto.columnId || item.columnId;
    const targetRank =
      typeof reorderDto.rank === 'number' ? reorderDto.rank : 0;

    let targetStateDone: boolean | undefined;
    if (typeof this.coreRepository.findStateById === 'function') {
      const targetState = await this.coreRepository
        .findStateById(targetColumn)
        .catch(() => null);
      if (targetState) {
        targetStateDone = targetState.group === 'completed';
      }
    }

    const columnItems = await this.coreRepository.findStateWorkItems(
      item.projectId,
      targetColumn,
    );

    const checkColDone = (col?: string | null) =>
      targetStateDone !== undefined ? targetStateDone : isStateCompleted(col);

    const updates = this.rankHandler.calculateReorder(
      columnItems,
      item.id,
      targetColumn,
      targetRank,
      checkColDone,
      item,
    );

    if (updates.length > 0) {
      await this.coreRepository.updateWorkItemsRank(updates);
      await this.invalidateCache(item.projectId, item.id);
    }

    this.eventHandler.emitWorkItemReordered({
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
    const source = await this.coreRepository.findWorkItemById(workItemId);
    if (!source) throw new NotFoundException('WorkItem not found');

    const sourceMemberRole =
      await this.coreRepository.findProjectMemberRole(
        source.projectId,
        userId,
      );
    if (!sourceMemberRole) {
      throw new ForbiddenException(
        'Insufficient permissions to access source work item',
      );
    }

    if (destinationProjectId && destinationProjectId !== source.projectId) {
      const destMemberRole =
        await this.coreRepository.findProjectMemberRole(
          destinationProjectId,
          userId,
        );
      if (
        !destMemberRole ||
        !['owner', 'coordinator', 'contributor'].includes(
          destMemberRole.toLowerCase(),
        )
      ) {
        throw new ForbiddenException(
          'Insufficient permissions to create work items in destination project',
        );
      }
    }

    const { cloneData, targetProjectId } =
      await this.cloneHandler.buildCloneData(
        source,
        userId,
        destinationProjectId,
      );
    const cloned = await this.coreRepository.createWorkItem(cloneData);
    await this.invalidateCache(targetProjectId, cloned.id);

    this.eventHandler.emitWorkItemDuplicated({
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
    const item = await this.coreRepository.findWorkItemById(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    const updated = await this.coreRepository.disconnectParentWorkItem(
      item.id,
    );

    await this.invalidateCache(item.projectId, item.id);
    if (item.parentWorkItemId) {
      await this.invalidateCache(item.projectId, item.parentWorkItemId);
    }
    const formatted = formatWorkItem(updated);
    return {
      message: 'WorkItem converted to root work item successfully',
      workItem: formatted,
    };
  }

  async getWorkItemAnalytics(projectId: string) {
    const items = await this.getProjectWorkItems(projectId);
    return calculateWorkItemAnalytics(items);
  }
}
