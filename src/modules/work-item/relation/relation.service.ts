import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { Prisma } from '@prisma/client';
import { RelationRepository } from './relation.repository';
import { AddRelationDto } from './dto/relation.dto';
import {
  RelationType,
  WorkItemRelationItem,
  EnrichedRelationItem,
} from './types/relation.types';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';
import * as crypto from 'crypto';

export const INVERSE_RELATION_MAP: Record<RelationType, RelationType> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates_to: 'relates_to',
  duplicate_of: 'duplicated_by',
  duplicated_by: 'duplicate_of',
  starts_before: 'starts_after',
  starts_after: 'starts_before',
  finishes_before: 'finishes_after',
  finishes_after: 'finishes_before',
  implements: 'implements',
};

@Injectable()
export class RelationService {
  constructor(
    private readonly relationRepository: RelationRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateTaskCache(
    projectId: string,
    taskId?: string,
    cycleId?: string | null,
  ) {
    if (!this.cache) return;
    const deletions: Promise<any>[] = [
      this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)),
      this.cache.del(`flux:proj:overview:${projectId}`),
    ];
    if (taskId) {
      deletions.push(this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)));
    }
    if (cycleId) {
      deletions.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.cycle(cycleId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectCycles(projectId)),
      );
    }
    await Promise.all(deletions).catch(() => null);
  }

  async getTaskRelations(
    taskId: string,
  ): Promise<{ relations: EnrichedRelationItem[] }> {
    const task = await this.relationRepository.findTask(taskId);
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const rawRelations: WorkItemRelationItem[] = Array.isArray(task.relations)
      ? (task.relations as unknown as WorkItemRelationItem[])
      : [];

    if (rawRelations.length === 0) {
      return { relations: [] };
    }

    const targetIds = rawRelations.map((relation) => relation.targetTaskId).filter(Boolean);
    const targetTasks = await this.relationRepository.findTasksByIds(targetIds);
    const taskMap = new Map(targetTasks.map((targetTask) => [targetTask.id, targetTask]));

    const enriched: EnrichedRelationItem[] = rawRelations.map((relation) => {
      const target = taskMap.get(relation.targetTaskId);
      return {
        ...relation,
        targetTask: target
          ? {
              id: target.id,
              title: target.title,
              identifier: target.identifier,
              columnId: target.columnId,
              priority: target.priority,
              completed: target.completed,
            }
          : null,
      };
    });

    return { relations: enriched };
  }

  async addRelation(taskId: string, addRelationDto: AddRelationDto, actorId?: string) {
    const sourceTask = await this.relationRepository.findTask(taskId);
    if (!sourceTask) {
      throw new NotFoundException('Source task not found');
    }

    const targetTask = await this.relationRepository.findTask(addRelationDto.targetTaskId);
    if (!targetTask) {
      throw new NotFoundException('Target task not found');
    }

    if (sourceTask.id === targetTask.id) {
      throw new BadRequestException('Cannot link task to itself');
    }

    const targetType = INVERSE_RELATION_MAP[addRelationDto.type] || 'relates_to';
    const now = new Date().toISOString();

    const sourceRelations: WorkItemRelationItem[] = (
      Array.isArray(sourceTask.relations)
        ? (sourceTask.relations as unknown as WorkItemRelationItem[])
        : []
    ).filter((relation) => relation.targetTaskId !== targetTask.id);

    sourceRelations.push({
      id: crypto.randomUUID(),
      targetTaskId: targetTask.id,
      type: addRelationDto.type,
      createdAt: now,
    });

    const targetRelations: WorkItemRelationItem[] = (
      Array.isArray(targetTask.relations)
        ? (targetTask.relations as unknown as WorkItemRelationItem[])
        : []
    ).filter((relation) => relation.targetTaskId !== sourceTask.id);

    targetRelations.push({
      id: crypto.randomUUID(),
      targetTaskId: sourceTask.id,
      type: targetType,
      createdAt: now,
    });

    await this.relationRepository.executeTransaction([
      this.relationRepository.prisma.task.update({
        where: { id: sourceTask.id },
        data: {
          relations: sourceRelations as unknown as Prisma.InputJsonValue,
        },
      }),
      this.relationRepository.prisma.task.update({
        where: { id: targetTask.id },
        data: {
          relations: targetRelations as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    await this.invalidateTaskCache(
      sourceTask.projectId,
      sourceTask.id,
      sourceTask.cycleId,
    );
    await this.invalidateTaskCache(
      targetTask.projectId,
      targetTask.id,
      targetTask.cycleId,
    );

    if (this.eventEmitter) {
      this.eventEmitter.emit('task.relation.added', {
        sourceTaskId: sourceTask.id,
        targetTaskId: targetTask.id,
        type: addRelationDto.type,
        actorId,
        projectId: sourceTask.projectId,
      });
    }

    return {
      success: true,
      message: 'Relation added successfully',
      relations: sourceRelations,
    };
  }

  async removeRelation(taskId: string, targetTaskId: string, actorId?: string) {
    const sourceTask = await this.relationRepository.findTask(taskId);
    if (!sourceTask) {
      throw new NotFoundException('Source task not found');
    }

    const targetTask = await this.relationRepository.findTask(targetTaskId);

    const sourceRelations = (
      Array.isArray(sourceTask.relations)
        ? (sourceTask.relations as unknown as WorkItemRelationItem[])
        : []
    ).filter((relation) => relation.targetTaskId !== (targetTask?.id || targetTaskId));

    const updates: Promise<any>[] = [
      this.relationRepository.prisma.task.update({
        where: { id: sourceTask.id },
        data: {
          relations: sourceRelations as unknown as Prisma.InputJsonValue,
        },
      }),
    ];

    if (targetTask) {
      const targetRelations = (
        Array.isArray(targetTask.relations)
          ? (targetTask.relations as unknown as WorkItemRelationItem[])
          : []
      ).filter((relation) => relation.targetTaskId !== sourceTask.id);

      updates.push(
        this.relationRepository.prisma.task.update({
          where: { id: targetTask.id },
          data: {
            relations: targetRelations as unknown as Prisma.InputJsonValue,
          },
        }),
      );
    }

    await this.relationRepository.executeTransaction(updates as any);

    await this.invalidateTaskCache(
      sourceTask.projectId,
      sourceTask.id,
      sourceTask.cycleId,
    );
    if (targetTask) {
      await this.invalidateTaskCache(
        targetTask.projectId,
        targetTask.id,
        targetTask.cycleId,
      );
    }

    if (this.eventEmitter) {
      this.eventEmitter.emit('task.relation.removed', {
        sourceTaskId: sourceTask.id,
        targetTaskId,
        actorId,
        projectId: sourceTask.projectId,
      });
    }

    return { success: true, message: 'Relation removed successfully' };
  }

  /**
   * Returns all timeline-dependency relations for a task that violate date constraints.
   * A violation occurs when the dates of the two tasks conflict with the relation type:
   *   - blocks/blocked_by: source dueDate > target startDate
   *   - starts_before: source startDate >= target startDate
   *   - starts_after:  source startDate <= target startDate
   *   - finishes_before: source dueDate >= target dueDate
   *   - finishes_after:  source dueDate <= target dueDate
   */
  async getViolatedRelations(taskId: string): Promise<{
    violations: Array<{
      relationId: string;
      type: RelationType;
      targetTaskId: string;
      targetTitle: string;
      reason: string;
      isViolated: boolean;
    }>;
  }> {
    const task = await this.relationRepository.findTask(taskId);
    if (!task) throw new NotFoundException('Task not found');

    const rawRelations: WorkItemRelationItem[] = Array.isArray(task.relations)
      ? (task.relations as unknown as WorkItemRelationItem[])
      : [];

    if (rawRelations.length === 0) return { violations: [] };

    const TIMELINE_TYPES: RelationType[] = [
      'blocks', 'blocked_by',
      'starts_before', 'starts_after',
      'finishes_before', 'finishes_after',
    ];

    const timelineRelations = rawRelations.filter((relation) =>
      TIMELINE_TYPES.includes(relation.type),
    );
    if (timelineRelations.length === 0) return { violations: [] };

    const targetIds = timelineRelations.map((relation) => relation.targetTaskId);
    const targetTasks = await this.relationRepository.findTasksByIds(targetIds);
    const taskMap = new Map(targetTasks.map((targetTask) => [targetTask.id, targetTask]));

    const sourceStart = task.startDate ? new Date(task.startDate) : null;
    const sourceDue = task.dueDate ? new Date(task.dueDate) : null;

    const violations = timelineRelations.map((relation) => {
      const target = taskMap.get(relation.targetTaskId);
      const targetStart = target?.startDate ? new Date(target.startDate) : null;
      const targetDue = target?.dueDate ? new Date(target.dueDate) : null;

      let isViolated = false;
      let reason = '';

      if (target) {
        switch (relation.type) {
          case 'blocks':
          case 'blocked_by':
            if (sourceDue && targetStart && sourceDue > targetStart) {
              isViolated = true;
              reason = `Due date (${sourceDue.toDateString()}) overlaps target start (${targetStart.toDateString()})`;
            }
            break;
          case 'starts_before':
            if (sourceStart && targetStart && sourceStart >= targetStart) {
              isViolated = true;
              reason = `Must start before target (${targetStart.toDateString()}) but starts on ${sourceStart.toDateString()}`;
            }
            break;
          case 'starts_after':
            if (sourceStart && targetStart && sourceStart <= targetStart) {
              isViolated = true;
              reason = `Must start after target (${targetStart.toDateString()}) but starts on ${sourceStart.toDateString()}`;
            }
            break;
          case 'finishes_before':
            if (sourceDue && targetDue && sourceDue >= targetDue) {
              isViolated = true;
              reason = `Must finish before target (${targetDue.toDateString()}) but finishes on ${sourceDue.toDateString()}`;
            }
            break;
          case 'finishes_after':
            if (sourceDue && targetDue && sourceDue <= targetDue) {
              isViolated = true;
              reason = `Must finish after target (${targetDue.toDateString()}) but finishes on ${sourceDue.toDateString()}`;
            }
            break;
        }
      }

      return {
        relationId: relation.id || '',
        type: relation.type,
        targetTaskId: relation.targetTaskId,
        targetTitle: target?.title || 'Unknown',
        reason,
        isViolated,
      };
    });

    return { violations };
  }
}
