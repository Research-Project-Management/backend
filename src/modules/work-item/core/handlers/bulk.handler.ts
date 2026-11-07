import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { CoreRepository } from '@/modules/work-item/core/core.repository';
import { EventHandler } from './event.handler';
import {
  BulkUpdateWorkItemDto,
  BulkUpdatePayload,
  BulkDeleteWorkItemDto,
} from '@/modules/work-item/core/dto/core.dto';
import { mapPriority } from '@/modules/work-item/core/utils/core.util';
import {
  isStateCompleted,
  matchProjectState,
} from '@/modules/work-item/state/utils/state.util';
import { normalizeStringIds } from '@/modules/work-item/common/types/shared.types';
import { invalidateWorkItemCache } from '@/modules/work-item/common/constants/redis.constant';
import { RedisCacheService, isUuid } from '@/core';
import { Prisma } from '@prisma/client';

@Injectable()
export class BulkHandler {
  constructor(
    private readonly coreRepository: CoreRepository,
    private readonly eventHandler: EventHandler,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private normalizeIds(rawIds: string[]): string[] {
    return normalizeStringIds(rawIds);
  }

  private async notifyCacheInvalidated(
    projectId: string | undefined,
    onInvalidateCache?: (projectId: string) => Promise<void>,
  ): Promise<void> {
    if (!projectId) return;
    if (onInvalidateCache) {
      await onInvalidateCache(projectId);
      return;
    }
    await invalidateWorkItemCache(this.cache, { projectId });
  }

  private async resolveEffectiveProjectId(
    projectId: string | undefined,
    rawIds: string[],
  ): Promise<string> {
    if (projectId) return projectId;
    if (rawIds.length > 0) {
      const firstItem = await this.coreRepository.findWorkItemById(
        rawIds[0],
      );
      if (firstItem) return firstItem.projectId;
    }
    return '';
  }

  private async bulkModifyLabel(
    effectiveProjectId: string,
    rawIds: string[],
    labelId: string,
    mode: 'add' | 'remove',
    onInvalidateCache?: (projectId: string) => Promise<void>,
  ) {
    const validIds = this.normalizeIds(rawIds).filter(isUuid);
    const allItems = await this.coreRepository.findWorkItemsByIds(validIds);
    const items = effectiveProjectId
      ? allItems.filter((t) => t.projectId === effectiveProjectId)
      : allItems;

    let canonicalLabelName = labelId;
    if (
      effectiveProjectId &&
      typeof this.coreRepository.findLabelsByIds === 'function'
    ) {
      const matchedLabels = await this.coreRepository
        .findLabelsByIds(effectiveProjectId, [labelId])
        .catch(() => []);
      if (matchedLabels.length > 0 && matchedLabels[0].name) {
        canonicalLabelName = matchedLabels[0].name;
      }
    }

    await Promise.all(
      items.map((t) => {
        const current = Array.isArray(t.labels) ? t.labels : [];
        const hasLabel =
          current.includes(canonicalLabelName) || current.includes(labelId);
        if (mode === 'add') {
          if (hasLabel) return Promise.resolve();
          return this.coreRepository.updateWorkItem(t.id, {
            labels: [...current, canonicalLabelName],
          });
        }
        if (!hasLabel) return Promise.resolve();
        return this.coreRepository.updateWorkItem(t.id, {
          labels: current.filter(
            (l) => l !== canonicalLabelName && l !== labelId,
          ),
        });
      }),
    );

    await this.notifyCacheInvalidated(effectiveProjectId, onInvalidateCache);

    return {
      message:
        mode === 'add'
          ? `Label added to ${items.length} work items`
          : `Label removed from ${items.length} work items`,
      count: items.length,
    };
  }

  async bulkUpdate(
    projectId: string,
    bulkUpdateWorkItemDto: BulkUpdateWorkItemDto,
    userId?: string,
    onInvalidateCache?: (projectId: string) => Promise<void>,
  ) {
    const payload: BulkUpdatePayload =
      bulkUpdateWorkItemDto.data ||
      (bulkUpdateWorkItemDto as unknown as BulkUpdatePayload);

    const rawIds = this.normalizeIds(
      bulkUpdateWorkItemDto.workItemIds || bulkUpdateWorkItemDto.ids || [],
    );
    const effectiveProjectId = await this.resolveEffectiveProjectId(
      projectId,
      rawIds,
    );

    if (typeof payload.addLabel === 'string') {
      return this.bulkModifyLabel(
        effectiveProjectId,
        rawIds,
        payload.addLabel,
        'add',
        onInvalidateCache,
      );
    }

    if (typeof payload.removeLabel === 'string') {
      return this.bulkModifyLabel(
        effectiveProjectId,
        rawIds,
        payload.removeLabel,
        'remove',
        onInvalidateCache,
      );
    }

    const rawProject = effectiveProjectId
      ? await this.coreRepository.findProjectWithStates(effectiveProjectId)
      : null;
    const canonicalProjectId = rawProject?.id || effectiveProjectId;

    const data: Prisma.WorkItemUpdateManyMutationInput & {
      assigneeId?: string | null;
      columnId?: string;
      labels?: string[];
    } = {};
    if (payload.columnId !== undefined) {
      const targetState = matchProjectState(
        rawProject?.states,
        payload.columnId,
        false,
      );
      data.columnId = targetState ? targetState.id : payload.columnId;
      data.completed = targetState
        ? isStateCompleted(targetState)
        : isStateCompleted(data.columnId);
    } else if (payload.completed !== undefined) {
      if (payload.completed) {
        const completedState = rawProject?.states?.find((s) =>
          isStateCompleted(s),
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
        const isMember = await this.coreRepository.isProjectMember(
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
        (l: unknown): l is string => typeof l === 'string' && l.trim().length > 0,
      );
    }

    const targetProjId = canonicalProjectId || effectiveProjectId || projectId;
    const result = await this.coreRepository.bulkUpdateWorkItems(
      targetProjId,
      rawIds,
      data,
    );
    await this.notifyCacheInvalidated(targetProjId, onInvalidateCache);
    this.eventHandler.emitBulkUpdated(targetProjId, userId, rawIds);
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
    const rawIds = this.normalizeIds(
      bulkDeleteWorkItemDto.workItemIds || bulkDeleteWorkItemDto.ids || [],
    );
    const effectiveProjectId = await this.resolveEffectiveProjectId(
      projectId,
      rawIds,
    );
    if (!effectiveProjectId) {
      throw new BadRequestException('Project context required for bulk delete');
    }

    const result = await this.coreRepository.bulkDeleteWorkItems(
      effectiveProjectId,
      rawIds,
    );
    await this.notifyCacheInvalidated(effectiveProjectId, onInvalidateCache);
    this.eventHandler.emitBulkDeleted(effectiveProjectId, userId, rawIds);
    return {
      message: `${result.count} work items deleted successfully`,
      count: result.count,
    };
  }
}
