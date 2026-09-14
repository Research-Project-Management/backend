import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis.service';
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
    if (workItemId) {
      deletions.push(this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(workItemId)));
    }
    if (cycleId) {
      deletions.push(
        this.cache.del(WORK_ITEM_REDIS_KEYS.cycle(cycleId)),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectCycles(projectId)),
      );
    }
    await Promise.all(deletions).catch(() => null);
  }

  async getWorkItemRelations(
    workItemId: string,
  ): Promise<{ relations: EnrichedRelationItem[] }> {
    const workItem = await this.relationRepository.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException('WorkItem not found');
    }

    const rawRelations: WorkItemRelationItem[] = Array.isArray(
      workItem.relations,
    )
      ? (workItem.relations as unknown as WorkItemRelationItem[])
      : [];

    if (rawRelations.length === 0) {
      return { relations: [] };
    }

    const targetIds = rawRelations
      .map((relation) => relation.targetWorkItemId)
      .filter(Boolean);
    const targetWorkItems =
      await this.relationRepository.findWorkItemsByIds(targetIds);
    const itemMap = new Map(
      targetWorkItems.map((targetItem) => [targetItem.id, targetItem]),
    );

    const enriched: EnrichedRelationItem[] = rawRelations.map((relation) => {
      const target = itemMap.get(relation.targetWorkItemId);
      return {
        ...relation,
        targetWorkItem: target
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

  async addRelation(
    workItemId: string,
    addRelationDto: AddRelationDto,
    actorId?: string,
  ) {
    const sourceItem = await this.relationRepository.findWorkItem(workItemId);
    if (!sourceItem) {
      throw new NotFoundException('Source WorkItem not found');
    }

    const targetItem = await this.relationRepository.findWorkItem(
      addRelationDto.targetWorkItemId,
    );
    if (!targetItem) {
      throw new NotFoundException('Target WorkItem not found');
    }

    if (sourceItem.id === targetItem.id) {
      throw new BadRequestException('Cannot link WorkItem to itself');
    }

    if (sourceItem.projectId !== targetItem.projectId) {
      throw new BadRequestException(
        'Cannot link work items across different projects',
      );
    }

    const targetType =
      INVERSE_RELATION_MAP[addRelationDto.type] || 'relates_to';
    const now = new Date().toISOString();

    const sourceRelations: WorkItemRelationItem[] = (
      Array.isArray(sourceItem.relations)
        ? (sourceItem.relations as unknown as WorkItemRelationItem[])
        : []
    ).filter((relation) => relation.targetWorkItemId !== targetItem.id);

    sourceRelations.push({
      id: crypto.randomUUID(),
      targetWorkItemId: targetItem.id,
      type: addRelationDto.type,
      createdAt: now,
    });

    const targetRelations: WorkItemRelationItem[] = (
      Array.isArray(targetItem.relations)
        ? (targetItem.relations as unknown as WorkItemRelationItem[])
        : []
    ).filter((relation) => relation.targetWorkItemId !== sourceItem.id);

    targetRelations.push({
      id: crypto.randomUUID(),
      targetWorkItemId: sourceItem.id,
      type: targetType,
      createdAt: now,
    });

    await this.relationRepository.executeTransaction([
      this.relationRepository.prisma.workItem.update({
        where: { id: sourceItem.id },
        data: {
          relations: sourceRelations as unknown as Prisma.InputJsonValue,
        },
      }),
      this.relationRepository.prisma.workItem.update({
        where: { id: targetItem.id },
        data: {
          relations: targetRelations as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    await this.invalidateWorkItemCache(
      sourceItem.projectId,
      sourceItem.id,
      sourceItem.cycleId,
    );
    await this.invalidateWorkItemCache(
      targetItem.projectId,
      targetItem.id,
      targetItem.cycleId,
    );

    if (this.eventEmitter) {
      const relationPayload = {
        entityType: 'work_item',
        entityId: sourceItem.id,
        workItemId: sourceItem.id,
        sourceWorkItemId: sourceItem.id,
        targetWorkItemId: targetItem.id,
        type: addRelationDto.type,
        actorId,
        projectId: sourceItem.projectId,
        verb: 'updated',
      };
      this.eventEmitter.emit('work-item.relation.added', relationPayload);
      this.eventEmitter.emit('work-item.updated', relationPayload);
    }

    return {
      success: true,
      message: 'Relation added successfully',
      relations: sourceRelations,
    };
  }

  async removeRelation(
    workItemId: string,
    targetWorkItemId: string,
    actorId?: string,
  ) {
    const sourceItem = await this.relationRepository.findWorkItem(workItemId);
    if (!sourceItem) {
      throw new NotFoundException('Source WorkItem not found');
    }

    const targetItem =
      await this.relationRepository.findWorkItem(targetWorkItemId);

    const sourceRelations = (
      Array.isArray(sourceItem.relations)
        ? (sourceItem.relations as unknown as WorkItemRelationItem[])
        : []
    ).filter(
      (relation) =>
        relation.targetWorkItemId !== (targetItem?.id || targetWorkItemId),
    );

    const updates: Promise<any>[] = [
      this.relationRepository.prisma.workItem.update({
        where: { id: sourceItem.id },
        data: {
          relations: sourceRelations as unknown as Prisma.InputJsonValue,
        },
      }),
    ];

    if (targetItem) {
      const targetRelations = (
        Array.isArray(targetItem.relations)
          ? (targetItem.relations as unknown as WorkItemRelationItem[])
          : []
      ).filter((relation) => relation.targetWorkItemId !== sourceItem.id);

      updates.push(
        this.relationRepository.prisma.workItem.update({
          where: { id: targetItem.id },
          data: {
            relations: targetRelations as unknown as Prisma.InputJsonValue,
          },
        }),
      );
    }

    await this.relationRepository.executeTransaction(updates as any);

    await this.invalidateWorkItemCache(
      sourceItem.projectId,
      sourceItem.id,
      sourceItem.cycleId,
    );
    if (targetItem) {
      await this.invalidateWorkItemCache(
        targetItem.projectId,
        targetItem.id,
        targetItem.cycleId,
      );
    }

    if (this.eventEmitter) {
      const relationPayload = {
        entityType: 'work_item',
        entityId: sourceItem.id,
        workItemId: sourceItem.id,
        sourceWorkItemId: sourceItem.id,
        targetWorkItemId,
        actorId,
        projectId: sourceItem.projectId,
        verb: 'updated',
      };
      this.eventEmitter.emit('work-item.relation.removed', relationPayload);
      this.eventEmitter.emit('work-item.updated', relationPayload);
    }

    return { success: true, message: 'Relation removed successfully' };
  }

  /**
   * Returns all timeline-dependency relations for a WorkItem that violate date constraints.
   * A violation occurs when the dates of the two work items conflict with the relation type:
   *   - blocks/blocked_by: source dueDate > target startDate
   *   - starts_before: source startDate >= target startDate
   *   - starts_after:  source startDate <= target startDate
   *   - finishes_before: source dueDate >= target dueDate
   *   - finishes_after:  source dueDate <= target dueDate
   */
  async getViolatedRelations(workItemId: string): Promise<{
    violations: Array<{
      relationId: string;
      type: RelationType;
      targetWorkItemId: string;
      targetTitle: string;
      reason: string;
      isViolated: boolean;
    }>;
  }> {
    const item = await this.relationRepository.findWorkItem(workItemId);
    if (!item) throw new NotFoundException('WorkItem not found');

    const rawRelations: WorkItemRelationItem[] = Array.isArray(item.relations)
      ? (item.relations as unknown as WorkItemRelationItem[])
      : [];

    if (rawRelations.length === 0) return { violations: [] };

    const TIMELINE_TYPES: RelationType[] = [
      'blocks',
      'blocked_by',
      'starts_before',
      'starts_after',
      'finishes_before',
      'finishes_after',
    ];

    const timelineRelations = rawRelations.filter((relation) =>
      TIMELINE_TYPES.includes(relation.type),
    );
    if (timelineRelations.length === 0) return { violations: [] };

    const targetIds = timelineRelations.map(
      (relation) => relation.targetWorkItemId,
    );
    const targetWorkItems =
      await this.relationRepository.findWorkItemsByIds(targetIds);
    const itemMap = new Map(
      targetWorkItems.map((targetItem) => [targetItem.id, targetItem]),
    );

    const sourceStart = item.startDate ? new Date(item.startDate) : null;
    const sourceDue = item.dueDate ? new Date(item.dueDate) : null;

    const violations = timelineRelations.map((relation) => {
      const target = itemMap.get(relation.targetWorkItemId);
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
        targetWorkItemId: relation.targetWorkItemId,
        targetTitle: target?.title || 'Unknown',
        reason,
        isViolated,
      };
    });

    return { violations };
  }
}
