import { Injectable, BadRequestException } from '@nestjs/common';
import { CoreRepository } from '../core.repository';
import { EventDispatcher } from './event.dispatcher';
import {
  BulkUpdateWorkItemDto,
  BulkUpdatePayload,
  BulkDeleteWorkItemDto,
} from '../dto/bulk.dto';
import { mapPriority } from '../utils/work-item.util';
import { isStateCompleted } from '../../common/utils/state-completion.util';
import { isUuid } from '@/core';
import { Prisma } from '@prisma/client';

@Injectable()
export class BulkHandler {
  constructor(
    private readonly workItemRepository: CoreRepository,
    private readonly eventDispatcher: EventDispatcher,
  ) {}

  async bulkUpdate(
    projectId: string,
    bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
    userId?: string,
    onInvalidateCache?: (projectId: string) => Promise<void>,
  ) {
    const payload: BulkUpdatePayload =
      bulkUpdateWorkItemDto.data ||
      (bulkUpdateWorkItemDto as unknown as BulkUpdatePayload);

    let effectiveProjectId = projectId;
    const rawIds =
      bulkUpdateWorkItemDto.workItemIds || bulkUpdateWorkItemDto.ids || [];
    if (!effectiveProjectId && rawIds.length > 0) {
      const firstItem = await this.workItemRepository.findWorkItemById(
        rawIds[0],
      );
      if (firstItem) {
        effectiveProjectId = firstItem.projectId;
      }
    }

    // Support bulk add single label to all selected items
    if (
      payload.addLabel !== undefined &&
      typeof payload.addLabel === 'string'
    ) {
      const labelId = payload.addLabel;
      const validIds = rawIds.filter(isUuid);
      const allItems =
        await this.workItemRepository.findWorkItemsByIds(validIds);
      const items = effectiveProjectId
        ? allItems.filter((t) => t.projectId === effectiveProjectId)
        : allItems;
      await Promise.all(
        items.map((t) => {
          const current = Array.isArray(t.labels) ? t.labels : [];
          if (current.includes(labelId)) return Promise.resolve();
          const next = [...current, labelId];
          return this.workItemRepository.updateWorkItem(t.id, { labels: next });
        }),
      );
      if (effectiveProjectId && onInvalidateCache) {
        await onInvalidateCache(effectiveProjectId);
      }
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
      const items = effectiveProjectId
        ? allItems.filter((t) => t.projectId === effectiveProjectId)
        : allItems;
      await Promise.all(
        items.map((t) => {
          const current = Array.isArray(t.labels) ? t.labels : [];
          if (!current.includes(labelId)) return Promise.resolve();
          const next = current.filter((l) => l !== labelId);
          return this.workItemRepository.updateWorkItem(t.id, { labels: next });
        }),
      );
      if (effectiveProjectId && onInvalidateCache) {
        await onInvalidateCache(effectiveProjectId);
      }
      return {
        message: `Label removed from ${items.length} work items`,
        count: items.length,
      };
    }

    const rawProject = effectiveProjectId
      ? await this.workItemRepository.findProjectWithColumns(effectiveProjectId)
      : null;
    const canonicalProjectId = rawProject?.id || effectiveProjectId;

    const data: Prisma.WorkItemUpdateManyMutationInput & {
      assigneeId?: string | null;
      columnId?: string;
    } = {};
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

    if (payload.dueDate !== undefined)
      data.dueDate = payload.dueDate ? new Date(payload.dueDate) : null;

    if (payload.startDate !== undefined)
      data.startDate = payload.startDate ? new Date(payload.startDate) : null;

    if (payload.clearLabels === true) {
      data.labels = [];
    } else if (payload.labels !== undefined && Array.isArray(payload.labels)) {
      data.labels = payload.labels.filter(
        (l: unknown) => typeof l === 'string' && l.trim().length > 0,
      );
    }

    const targetProjId = canonicalProjectId || effectiveProjectId || projectId;
    const result = await this.workItemRepository.bulkUpdateWorkItems(
      targetProjId,
      rawIds,
      data,
    );
    if (targetProjId && onInvalidateCache) {
      await onInvalidateCache(targetProjId);
    }
    this.eventDispatcher.emitBulkUpdated(targetProjId, userId, rawIds);
    return {
      message: `${result.count} work items updated successfully`,
      count: result.count,
    };
  }

  async bulkDelete(
    projectId: string,
    bulkDeleteWorkItemDto: BulkDeleteWorkItemDto,
    userId?: string,
    onInvalidateCache?: (projectId: string) => Promise<void>,
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
      throw new BadRequestException('Project context required for bulk delete');
    }

    const result = await this.workItemRepository.bulkDeleteWorkItems(
      effectiveProjectId,
      rawIds,
    );
    if (onInvalidateCache) {
      await onInvalidateCache(effectiveProjectId);
    }
    this.eventDispatcher.emitBulkDeleted(effectiveProjectId, userId, rawIds);
    return {
      message: `${result.count} work items deleted successfully`,
      count: result.count,
    };
  }
}
