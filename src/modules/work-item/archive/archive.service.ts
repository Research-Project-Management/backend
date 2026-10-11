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
import { WORK_ITEM_REDIS_KEYS } from '../common/constants/redis-keys.constant';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name);

  constructor(
    private readonly archiveRepository: ArchiveRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateWorkItemCache(
    workItemId: string,
    projectId?: string,
  ) {
    if (!this.cache) return;
    const promises: Promise<void>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(workItemId)),
    ];
    if (projectId) {
      promises.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId)),
      );
    }
    await Promise.all(promises).catch((err) => {
      this.logger.warn(
        `Failed to invalidate cache for work item ${workItemId}: ${(err as Error).message}`,
      );
    });
  }

  private async invalidateWorkItemsBulk(
    workItems: Array<{ id: string; projectId?: string | null }>,
  ) {
    if (!this.cache) return;
    const keys = new Set<string>();
    for (const item of workItems) {
      keys.add(WORK_ITEM_REDIS_KEYS.workItem(item.id));
      if (item.projectId) {
        keys.add(WORK_ITEM_REDIS_KEYS.projectWorkItems(item.projectId));
        keys.add(`flux:proj:overview:${item.projectId}`);
      }
    }
    const promises = Array.from(keys).map((key) => this.cache!.del(key));
    await Promise.all(promises).catch((err) => {
      this.logger.warn(
        `Failed to invalidate bulk work item cache: ${(err as Error).message}`,
      );
    });
  }

  async archiveWorkItem(workItemId: string, userId: string) {
    const workItem =
      await this.archiveRepository.findWorkItemWithProject(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item "${workItemId}" not found`);
    }
    if (workItem.archivedAt) {
      throw new BadRequestException(
        `Work item "${workItem.identifier || workItem.id}" is already archived`,
      );
    }

    const updated = await this.archiveRepository.archiveWorkItem(workItem.id);
    await this.invalidateWorkItemCache(workItem.id, workItem.projectId);

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.archived', {
        workItemId: workItem.id,
        identifier: workItem.identifier,
        projectId: workItem.projectId,
        userId,
      });

      this.eventEmitter.emit(
        'activity.log',
        new DomainActivityEvent({
          entityType: EntityType.work_item,
          entityId: workItem.id,
          verb: 'archived',
          actorId: userId,
          projectId: workItem.projectId,
        }),
      );
    }

    return {
      success: true,
      message: `Work item "${workItem.identifier || workItem.id}" has been archived`,
      workItem: updated,
      item: updated,
    };
  }

  async restoreWorkItem(workItemId: string, userId: string) {
    const workItem =
      await this.archiveRepository.findWorkItemWithProject(workItemId);
    if (!workItem) {
      throw new NotFoundException(`Work item "${workItemId}" not found`);
    }
    if (!workItem.archivedAt) {
      throw new BadRequestException(
        `Work item "${workItem.identifier || workItem.id}" is not archived`,
      );
    }

    const updated = await this.archiveRepository.restoreWorkItem(workItem.id);
    await this.invalidateWorkItemCache(workItem.id, workItem.projectId);

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.restored', {
        workItemId: workItem.id,
        identifier: workItem.identifier,
        projectId: workItem.projectId,
        userId,
      });

      this.eventEmitter.emit(
        'activity.log',
        new DomainActivityEvent({
          entityType: EntityType.work_item,
          entityId: workItem.id,
          verb: 'restored',
          actorId: userId,
          projectId: workItem.projectId,
        }),
      );
    }

    return {
      success: true,
      message: `Work item "${workItem.identifier || workItem.id}" has been restored to active boards`,
      workItem: updated,
      item: updated,
    };
  }

  async bulkArchiveWorkItems(bulkArchiveDto: BulkArchiveDto, userId: string) {
    const ids = bulkArchiveDto.workItemIds;
    const workItems = await this.archiveRepository.findWorkItemsByIds(ids);
    if (workItems.length === 0) {
      throw new BadRequestException('No valid work items found to archive');
    }

    const archiveResult = await this.archiveRepository.bulkArchive(ids);
    await this.invalidateWorkItemsBulk(workItems);

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.bulk-archived', {
        workItemIds: ids,
        count: archiveResult.count,
        userId,
        reason: bulkArchiveDto.reason,
      });

      for (const workItem of workItems) {
        this.eventEmitter.emit(
          'activity.log',
          new DomainActivityEvent({
            entityType: EntityType.work_item,
            entityId: workItem.id,
            verb: 'archived',
            actorId: userId,
            projectId: workItem.projectId,
          }),
        );
      }
    }

    return {
      success: true,
      count: archiveResult.count,
      message: `Successfully archived ${archiveResult.count} work item(s)`,
    };
  }

  async bulkRestoreWorkItems(bulkArchiveDto: BulkArchiveDto, userId: string) {
    const ids = bulkArchiveDto.workItemIds;
    const workItems = await this.archiveRepository.findWorkItemsByIds(ids);
    if (workItems.length === 0) {
      throw new BadRequestException('No valid work items found to restore');
    }

    const restoreResult = await this.archiveRepository.bulkRestore(ids);
    await this.invalidateWorkItemsBulk(workItems);

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.bulk-restored', {
        workItemIds: ids,
        count: restoreResult.count,
        userId,
      });

      for (const workItem of workItems) {
        this.eventEmitter.emit(
          'activity.log',
          new DomainActivityEvent({
            entityType: EntityType.work_item,
            entityId: workItem.id,
            verb: 'restored',
            actorId: userId,
            projectId: workItem.projectId,
          }),
        );
      }
    }

    return {
      success: true,
      count: restoreResult.count,
      message: `Successfully restored ${restoreResult.count} work item(s) to active boards`,
    };
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
