import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityType } from '@prisma/client';
import { ArchiveRepository } from './archive.repository';
import { BulkArchiveDto } from './dto/bulk-archive.dto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

@Injectable()
export class ArchiveService {
  constructor(
    private readonly archiveRepository: ArchiveRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateWorkItemCache(workItemId: string, projectId?: string) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(workItemId)),
    ];
    if (projectId) {
      promises.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId)),
      );
    }
    await Promise.all(promises).catch(() => {});
  }

  async archiveWorkItem(workItemId: string, userId: string) {
    const workItem = await this.archiveRepository.findWorkItemWithProject(workItemId);
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
    const workItem = await this.archiveRepository.findWorkItemWithProject(workItemId);
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

    const projectIds = new Set<string>();
    for (const workItem of workItems) {
      if (workItem.projectId) projectIds.add(workItem.projectId);
      await this.invalidateWorkItemCache(workItem.id, workItem.projectId);
    }

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

    for (const workItem of workItems) {
      await this.invalidateWorkItemCache(workItem.id, workItem.projectId);
    }

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
    return this.archiveRepository.findArchivedWorkItems(projectId, query);
  }
}
