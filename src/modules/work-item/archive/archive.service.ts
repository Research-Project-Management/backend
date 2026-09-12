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
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

@Injectable()
export class ArchiveService {
  constructor(
    private readonly archiveRepository: ArchiveRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateTaskCache(taskId: string, projectId?: string) {
    if (!this.cache) return;
    const promises: Promise<any>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)),
    ];
    if (projectId) {
      promises.push(this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)));
    }
    await Promise.all(promises).catch(() => {});
  }

  async archiveWorkItem(taskId: string, userId: string) {
    const task = await this.archiveRepository.findTaskWithProject(taskId);
    if (!task) {
      throw new NotFoundException(`Work item "${taskId}" not found`);
    }
    if (task.archivedAt) {
      throw new BadRequestException(`Work item "${task.identifier || task.id}" is already archived`);
    }

    const updated = await this.archiveRepository.archiveTask(task.id);
    await this.invalidateTaskCache(task.id, task.projectId);

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.archived', {
        taskId: task.id,
        identifier: task.identifier,
        projectId: task.projectId,
        userId,
      });

      if (task.project?.workspaceId) {
        this.eventEmitter.emit(
          'activity.log',
          new DomainActivityEvent({
            entityType: EntityType.task,
            entityId: task.id,
            verb: 'archived',
            actorId: userId,
            workspaceId: task.project.workspaceId,
            projectId: task.projectId,
          }),
        );
      }
    }

    return {
      success: true,
      message: `Work item "${task.identifier || task.id}" has been archived`,
      task: updated,
    };
  }

  async restoreWorkItem(taskId: string, userId: string) {
    const task = await this.archiveRepository.findTaskWithProject(taskId);
    if (!task) {
      throw new NotFoundException(`Work item "${taskId}" not found`);
    }
    if (!task.archivedAt) {
      throw new BadRequestException(`Work item "${task.identifier || task.id}" is not archived`);
    }

    const updated = await this.archiveRepository.restoreTask(task.id);
    await this.invalidateTaskCache(task.id, task.projectId);

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.restored', {
        taskId: task.id,
        identifier: task.identifier,
        projectId: task.projectId,
        userId,
      });

      if (task.project?.workspaceId) {
        this.eventEmitter.emit(
          'activity.log',
          new DomainActivityEvent({
            entityType: EntityType.task,
            entityId: task.id,
            verb: 'restored',
            actorId: userId,
            workspaceId: task.project.workspaceId,
            projectId: task.projectId,
          }),
        );
      }
    }

    return {
      success: true,
      message: `Work item "${task.identifier || task.id}" has been restored to active boards`,
      task: updated,
    };
  }

  async bulkArchiveWorkItems(bulkArchiveDto: BulkArchiveDto, userId: string) {
    const tasks = await this.archiveRepository.findTasksByIds(bulkArchiveDto.taskIds);
    if (tasks.length === 0) {
      throw new BadRequestException('No valid work items found to archive');
    }

    const archiveResult = await this.archiveRepository.bulkArchive(bulkArchiveDto.taskIds);

    const projectIds = new Set<string>();
    for (const task of tasks) {
      if (task.projectId) projectIds.add(task.projectId);
      await this.invalidateTaskCache(task.id, task.projectId);
    }

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.bulk-archived', {
        taskIds: bulkArchiveDto.taskIds,
        count: archiveResult.count,
        userId,
        reason: bulkArchiveDto.reason,
      });

      for (const task of tasks) {
        if (task.project?.workspaceId) {
          this.eventEmitter.emit(
            'activity.log',
            new DomainActivityEvent({
              entityType: EntityType.task,
              entityId: task.id,
              verb: 'archived',
              actorId: userId,
              workspaceId: task.project.workspaceId,
              projectId: task.projectId,
            }),
          );
        }
      }
    }

    return {
      success: true,
      count: archiveResult.count,
      message: `Successfully archived ${archiveResult.count} work item(s)`,
    };
  }

  async bulkRestoreWorkItems(bulkArchiveDto: BulkArchiveDto, userId: string) {
    const tasks = await this.archiveRepository.findTasksByIds(bulkArchiveDto.taskIds);
    if (tasks.length === 0) {
      throw new BadRequestException('No valid work items found to restore');
    }

    const restoreResult = await this.archiveRepository.bulkRestore(bulkArchiveDto.taskIds);

    for (const task of tasks) {
      await this.invalidateTaskCache(task.id, task.projectId);
    }

    if (this.eventEmitter) {
      this.eventEmitter.emit('work-item.bulk-restored', {
        taskIds: bulkArchiveDto.taskIds,
        count: restoreResult.count,
        userId,
      });

      for (const task of tasks) {
        if (task.project?.workspaceId) {
          this.eventEmitter.emit(
            'activity.log',
            new DomainActivityEvent({
              entityType: EntityType.task,
              entityId: task.id,
              verb: 'restored',
              actorId: userId,
              workspaceId: task.project.workspaceId,
              projectId: task.projectId,
            }),
          );
        }
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
    return this.archiveRepository.findArchivedTasks(projectId, query);
  }
}
