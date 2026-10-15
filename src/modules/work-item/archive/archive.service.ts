import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityType } from '@prisma/client';
import { ArchiveRepository } from './archive.repository';
import { BulkArchiveDto } from './dto/bulk-archive.dto';
import { RedisCacheService } from '@/core';
import {
  WORK_ITEM_REDIS_KEYS,
  invalidateWorkItemCache,
} from '@/modules/work-item/common/constants/redis-keys.constant';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name);

  constructor(
    private readonly archiveRepository: ArchiveRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateWorkItemsBulk(
    workItems: Array<{ id: string; projectId?: string | null }>,
  ) {
    if (!this.cache) return;
    const keys = new Set<string>();
    for (const item of workItems) {
      keys.add(WORK_ITEM_REDIS_KEYS.workItem(item.id));
      if (item.projectId) {
        keys.add(WORK_ITEM_REDIS_KEYS.projectWorkItems(item.projectId));
        keys.add(WORK_ITEM_REDIS_KEYS.projectOverview(item.projectId));
      }
    }
    const promises = Array.from(keys).map((key) => this.cache!.del(key));
    await Promise.all(promises).catch((err) => {
      this.logger.warn(
        `Failed to invalidate bulk work item cache: ${(err as Error).message}`,
      );
    });
  }

  private async setArchiveState(
    workItemId: string,
    userId: string,
    archive: boolean,
  ) {
    const workItem =
      await this.archiveRepository.findWorkItemWithProject(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item "${workItemId}" not found`);
    }

    const displayId = workItem.identifier || workItem.id;
    if (archive && workItem.archivedAt) {
      throw new BadRequestException(
        `Work item "${displayId}" is already archived`,
      );
    }
    if (!archive && !workItem.archivedAt) {
      throw new BadRequestException(`Work item "${displayId}" is not archived`);
    }

    const updated = archive
      ? await this.archiveRepository.archiveWorkItem(workItem.id)
      : await this.archiveRepository.restoreWorkItem(workItem.id);

    await invalidateWorkItemCache(this.cache, {
      workItemId: workItem.id,
      projectId: workItem.projectId,
    });

    const verb = archive ? 'archived' : 'restored';
    if (this.eventEmitter) {
      this.eventEmitter.emit(`work-item.${verb}`, {
        entityType: EntityType.work_item,
        entityId: workItem.id,
        workItemId: workItem.id,
        identifier: workItem.identifier,
        projectId: workItem.projectId,
        verb,
        actorId: userId,
        userId,
      });
    }

    return {
      success: true,
      message: archive
        ? `Work item "${displayId}" has been archived`
        : `Work item "${displayId}" has been restored to active boards`,
      workItem: updated,
      item: updated,
    };
  }

  private async bulkSetArchiveState(
    bulkArchiveDto: BulkArchiveDto,
    userId: string,
    archive: boolean,
  ) {
    const actionLabel = archive ? 'archive' : 'restore';
    const verb = archive ? 'archived' : 'restored';
    const rawIds = bulkArchiveDto.workItemIds || bulkArchiveDto.ids || [];
    const ids = Array.from(
      new Set(
        (Array.isArray(rawIds) ? rawIds : [])
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ).sort();
    if (ids.length === 0) {
      throw new BadRequestException(
        `No work item IDs provided to ${actionLabel}`,
      );
    }
    const workItems = await this.archiveRepository.findWorkItemsByIds(ids);
    if (workItems.length === 0) {
      throw new BadRequestException(
        `No valid work items found to ${actionLabel}`,
      );
    }

    const result = archive
      ? await this.archiveRepository.bulkArchive(ids)
      : await this.archiveRepository.bulkRestore(ids);
    await this.invalidateWorkItemsBulk(workItems);

    if (this.eventEmitter) {
      const projectId = bulkArchiveDto.projectId || workItems[0]?.projectId;
      this.eventEmitter.emit(`work-item.bulk-${verb}`, {
        entityType: EntityType.project,
        entityId: projectId,
        workItemIds: ids,
        count: result.count,
        projectId,
        verb,
        actorId: userId,
        userId,
        ...(archive ? { reason: bulkArchiveDto.reason } : {}),
      });

      for (const workItem of workItems) {
        this.eventEmitter.emit(
          'activity.event',
          new DomainActivityEvent({
            entityType: EntityType.work_item,
            entityId: workItem.id,
            verb,
            actorId: userId,
            projectId: workItem.projectId,
          }),
        );
      }
    }

    return {
      success: true,
      count: result.count,
      message: archive
        ? `Successfully archived ${result.count} work item(s)`
        : `Successfully restored ${result.count} work item(s) to active boards`,
    };
  }

  async archiveWorkItem(workItemId: string, userId: string) {
    return this.setArchiveState(workItemId, userId, true);
  }

  async restoreWorkItem(workItemId: string, userId: string) {
    return this.setArchiveState(workItemId, userId, false);
  }

  async bulkArchiveWorkItems(bulkArchiveDto: BulkArchiveDto, userId: string) {
    return this.bulkSetArchiveState(bulkArchiveDto, userId, true);
  }

  async bulkRestoreWorkItems(bulkArchiveDto: BulkArchiveDto, userId: string) {
    return this.bulkSetArchiveState(bulkArchiveDto, userId, false);
  }

  async getArchivedWorkItems(
    projectId: string,
    query: { page?: number; limit?: number; search?: string },
  ) {
    const res = await this.archiveRepository.findArchivedWorkItems(
      projectId,
      query,
    );
    return {
      ...res,
      archivedItems: res.workItems,
      count: res.total,
    };
  }
}
