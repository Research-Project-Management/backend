import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core';
import { Prisma, WorkItemRelationType } from '@prisma/client';
import { RelationRepository } from './relation.repository';
import { AddRelationDto } from './dto/relation.dto';
import {
  RelationType,
  WorkItemRelationItem,
  EnrichedRelationItem,
  TIMELINE_RELATION_TYPES,
} from './types/relation.types';
import { invalidateWorkItemCache } from '@/modules/work-item/common/constants/redis-keys.constant';
import * as crypto from 'crypto';

export const INVERSE_RELATION_MAP: Record<string, RelationType> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates_to: 'relates_to',
  duplicate_of: 'duplicated_by',
  duplicated_by: 'duplicate_of',
  starts_before: 'starts_after',
  starts_after: 'starts_before',
  finishes_before: 'finishes_after',
  finishes_after: 'finishes_before',
  start_to_finish: 'start_to_finish',
  finish_to_start: 'blocked_by',
  start_to_start: 'starts_after',
  finish_to_finish: 'finishes_after',
  implements: 'implements',
};

const BLOCKING_FORWARD_TYPES = new Set<string>([
  'blocks',
  'finish_to_start',
  'start_to_start',
  'finish_to_finish',
  'start_to_finish',
  'starts_before',
  'finishes_before',
]);

const BLOCKING_INVERSE_TYPES = new Set<string>([
  'blocked_by',
  'starts_after',
  'finishes_after',
]);

const DUPLICATE_FORWARD_TYPES = new Set<string>(['duplicate_of']);
const DUPLICATE_INVERSE_TYPES = new Set<string>(['duplicated_by']);

@Injectable()
export class RelationService {
  private readonly logger = new Logger(RelationService.name);

  constructor(
    private readonly relationRepository: RelationRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateCache(projectId: string, workItemId?: string) {
    await invalidateWorkItemCache(this.cache, { projectId, workItemId });
  }

  private extractRelations(workItem: {
    relations?: unknown;
    outgoingRelations?: Array<{
      id: string;
      sourceId: string;
      targetId: string;
      type: WorkItemRelationType | string;
      createdAt: Date | string;
    }>;
    incomingRelations?: Array<{
      id: string;
      sourceId: string;
      targetId: string;
      type: WorkItemRelationType | string;
      createdAt: Date | string;
    }>;
  }): WorkItemRelationItem[] {
    const jsonRelations: WorkItemRelationItem[] = Array.isArray(
      workItem.relations,
    )
      ? (workItem.relations as unknown as WorkItemRelationItem[])
      : [];

    const byTarget = new Map<string, WorkItemRelationItem>();
    for (const rel of jsonRelations) {
      if (rel?.targetWorkItemId) {
        byTarget.set(rel.targetWorkItemId, rel);
      }
    }

    if (Array.isArray(workItem.outgoingRelations)) {
      for (const outRel of workItem.outgoingRelations) {
        if (!byTarget.has(outRel.targetId)) {
          byTarget.set(outRel.targetId, {
            id: outRel.id,
            targetWorkItemId: outRel.targetId,
            type: String(outRel.type) as RelationType,
            createdAt:
              outRel.createdAt instanceof Date
                ? outRel.createdAt.toISOString()
                : String(outRel.createdAt),
          });
        }
      }
    }

    if (Array.isArray(workItem.incomingRelations)) {
      for (const inRel of workItem.incomingRelations) {
        if (!byTarget.has(inRel.sourceId)) {
          const normalizedType = String(inRel.type).toLowerCase();
          const inverseType =
            INVERSE_RELATION_MAP[normalizedType] || 'relates_to';
          byTarget.set(inRel.sourceId, {
            id: inRel.id,
            targetWorkItemId: inRel.sourceId,
            type: inverseType,
            createdAt:
              inRel.createdAt instanceof Date
                ? inRel.createdAt.toISOString()
                : String(inRel.createdAt),
          });
        }
      }
    }

    return Array.from(byTarget.values());
  }

  async getWorkItemRelations(
    workItemId: string,
  ): Promise<{ relations: EnrichedRelationItem[] }> {
    const workItem = await this.relationRepository.findWorkItem(workItemId);
    if (!workItem) {
      throw new NotFoundException('WorkItem not found');
    }

    const rawRelations = this.extractRelations(workItem);

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

  /**
   * Check if a directed path exists between startId and goalId for a given relation type semantics.
   * Uses an in-memory BFS over the project graph to eliminate O(V) database roundtrips.
   */
  private async hasDirectedPath(
    startId: string,
    goalId: string,
    relationCategory: 'blocks' | 'duplicate_of',
    projectId?: string,
    maxDepth = 50,
  ): Promise<boolean> {
    if (startId === goalId) return true;

    let edges: Array<{ sourceId: string; targetId: string }> = [];

    if (
      this.relationRepository &&
      typeof this.relationRepository.findProjectGraphEdges === 'function' &&
      projectId
    ) {
      edges = await this.relationRepository.findProjectGraphEdges(
        projectId,
        relationCategory,
      );
    } else if (this.relationRepository?.prisma) {
      return this.fallbackHasDirectedPath(
        startId,
        goalId,
        relationCategory,
        maxDepth,
      );
    }

    const adj = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!edge.sourceId || !edge.targetId || edge.sourceId === edge.targetId) {
        continue;
      }
      let neighbors = adj.get(edge.sourceId);
      if (!neighbors) {
        neighbors = new Set<string>();
        adj.set(edge.sourceId, neighbors);
      }
      neighbors.add(edge.targetId);
    }

    const visited = new Set<string>([startId]);
    const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id: currentId, depth } = queue.shift()!;
      if (depth >= maxDepth) break;

      const neighbors = adj.get(currentId);
      if (!neighbors) continue;

      for (const nextId of neighbors) {
        if (nextId === goalId) {
          return true;
        }
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({ id: nextId, depth: depth + 1 });
        }
      }
    }

    return false;
  }

  private async fallbackHasDirectedPath(
    startId: string,
    goalId: string,
    relationCategory: 'blocks' | 'duplicate_of',
    maxDepth = 30,
  ): Promise<boolean> {
    const visited = new Set<string>([startId]);
    const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
    const isBlocks = relationCategory === 'blocks';

    while (queue.length > 0) {
      const { id: currentId, depth } = queue.shift()!;
      if (depth >= maxDepth) break;

      const nextNodeIds = new Set<string>();

      const outgoingRelations =
        (await this.relationRepository.prisma.workItemRelation.findMany({
          where: isBlocks
            ? {
                OR: [
                  { sourceId: currentId, type: 'blocks' },
                  { targetId: currentId, type: 'blocked_by' },
                ],
              }
            : {
                sourceId: currentId,
                type: 'duplicate_of',
              },
          select: isBlocks
            ? { sourceId: true, targetId: true, type: true }
            : { targetId: true },
        })) as Array<{ sourceId?: string; targetId?: string; type?: string }>;

      for (const rel of outgoingRelations) {
        const nextId =
          isBlocks && rel.type === 'blocked_by' ? rel.sourceId : rel.targetId;
        if (nextId && nextId !== currentId) {
          nextNodeIds.add(nextId);
        }
      }

      const currentItem =
        await this.relationRepository.prisma.workItem.findUnique({
          where: { id: currentId },
          select: { relations: true },
        });

      if (currentItem && Array.isArray(currentItem.relations)) {
        for (const r of currentItem.relations as unknown as WorkItemRelationItem[]) {
          if (r.type === relationCategory && r.targetWorkItemId) {
            nextNodeIds.add(r.targetWorkItemId);
          }
        }
      }

      for (const nextId of nextNodeIds) {
        if (nextId === goalId) {
          return true;
        }
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push({ id: nextId, depth: depth + 1 });
        }
      }
    }

    return false;
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

    const existingSourceRelations = this.extractRelations(sourceItem);
    const normalizedInputType = String(
      addRelationDto.type,
    ).toLowerCase() as RelationType;

    const isDuplicateRelation = existingSourceRelations.some(
      (r) =>
        r.targetWorkItemId === targetItem.id &&
        String(r.type).toLowerCase() === normalizedInputType,
    );
    if (isDuplicateRelation) {
      throw new ConflictException(
        `Relation of type "${addRelationDto.type}" already exists between these work items`,
      );
    }

    if (BLOCKING_FORWARD_TYPES.has(normalizedInputType)) {
      const wouldCycle = await this.hasDirectedPath(
        targetItem.id,
        sourceItem.id,
        'blocks',
        sourceItem.projectId,
      );
      if (wouldCycle) {
        throw new BadRequestException(
          'Circular dependency detected: Work items cannot block each other directly or transitively.',
        );
      }
    } else if (BLOCKING_INVERSE_TYPES.has(normalizedInputType)) {
      const wouldCycle = await this.hasDirectedPath(
        sourceItem.id,
        targetItem.id,
        'blocks',
        sourceItem.projectId,
      );
      if (wouldCycle) {
        throw new BadRequestException(
          'Circular dependency detected: Work item cannot be blocked by a work item that it already blocks directly or transitively.',
        );
      }
    } else if (DUPLICATE_FORWARD_TYPES.has(normalizedInputType)) {
      const wouldCycle = await this.hasDirectedPath(
        targetItem.id,
        sourceItem.id,
        'duplicate_of',
        sourceItem.projectId,
      );
      if (wouldCycle) {
        throw new BadRequestException(
          'Circular dependency detected: Work items cannot be duplicates of each other directly or transitively.',
        );
      }
    } else if (DUPLICATE_INVERSE_TYPES.has(normalizedInputType)) {
      const wouldCycle = await this.hasDirectedPath(
        sourceItem.id,
        targetItem.id,
        'duplicate_of',
        sourceItem.projectId,
      );
      if (wouldCycle) {
        throw new BadRequestException(
          'Circular dependency detected: Work items cannot be duplicates of each other directly or transitively.',
        );
      }
    }

    const targetType =
      INVERSE_RELATION_MAP[normalizedInputType] || 'relates_to';
    const now = new Date().toISOString();

    const sourceRelations: WorkItemRelationItem[] =
      existingSourceRelations.filter(
        (relation) => relation.targetWorkItemId !== targetItem.id,
      );

    sourceRelations.push({
      id: crypto.randomUUID(),
      targetWorkItemId: targetItem.id,
      type: addRelationDto.type,
      createdAt: now,
    });

    const targetRelations: WorkItemRelationItem[] = this.extractRelations(
      targetItem,
    ).filter((relation) => relation.targetWorkItemId !== sourceItem.id);

    targetRelations.push({
      id: crypto.randomUUID(),
      targetWorkItemId: sourceItem.id,
      type: targetType,
      createdAt: now,
    });

    const dbRelationType: WorkItemRelationType = BLOCKING_FORWARD_TYPES.has(
      normalizedInputType,
    )
      ? WorkItemRelationType.blocks
      : BLOCKING_INVERSE_TYPES.has(normalizedInputType)
        ? WorkItemRelationType.blocked_by
        : DUPLICATE_FORWARD_TYPES.has(normalizedInputType) ||
            DUPLICATE_INVERSE_TYPES.has(normalizedInputType)
          ? WorkItemRelationType.duplicate_of
          : WorkItemRelationType.relates_to;

    await this.relationRepository.prisma.$transaction(async (tx) => {
      await tx.workItem.update({
        where: { id: sourceItem.id },
        data: {
          relations: sourceRelations as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.workItem.update({
        where: { id: targetItem.id },
        data: {
          relations: targetRelations as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.workItemRelation.upsert({
        where: {
          sourceId_targetId_type: {
            sourceId: sourceItem.id,
            targetId: targetItem.id,
            type: dbRelationType,
          },
        },
        create: {
          sourceId: sourceItem.id,
          targetId: targetItem.id,
          type: dbRelationType,
        },
        update: {},
      });
    });

    await this.invalidateCache(sourceItem.projectId, sourceItem.id);
    await this.invalidateCache(targetItem.projectId, targetItem.id);

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

    const effectiveTargetId = targetItem?.id || targetWorkItemId;

    await this.relationRepository.prisma.$transaction(async (tx) => {
      await tx.workItem.update({
        where: { id: sourceItem.id },
        data: {
          relations: sourceRelations as unknown as Prisma.InputJsonValue,
        },
      });

      if (targetItem) {
        const targetRelations = (
          Array.isArray(targetItem.relations)
            ? (targetItem.relations as unknown as WorkItemRelationItem[])
            : []
        ).filter((relation) => relation.targetWorkItemId !== sourceItem.id);

        await tx.workItem.update({
          where: { id: targetItem.id },
          data: {
            relations: targetRelations as unknown as Prisma.InputJsonValue,
          },
        });
      }

      await tx.workItemRelation.deleteMany({
        where: {
          OR: [
            { sourceId: sourceItem.id, targetId: effectiveTargetId },
            { sourceId: effectiveTargetId, targetId: sourceItem.id },
          ],
        },
      });
    });

    await this.invalidateCache(sourceItem.projectId, sourceItem.id);
    if (targetItem) {
      await this.invalidateCache(targetItem.projectId, targetItem.id);
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

    const rawRelations = this.extractRelations(item);

    if (rawRelations.length === 0) return { violations: [] };

    const timelineRelations = rawRelations.filter((relation) =>
      TIMELINE_RELATION_TYPES.includes(relation.type),
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
        switch (String(relation.type).toLowerCase()) {
          case 'blocks':
          case 'finish_to_start':
            if (
              sourceDue &&
              targetStart &&
              sourceDue.getTime() > targetStart.getTime()
            ) {
              isViolated = true;
              reason = `Due date (${sourceDue.toDateString()}) overlaps target start (${targetStart.toDateString()})`;
            }
            break;
          case 'blocked_by':
            if (
              sourceStart &&
              targetDue &&
              targetDue.getTime() > sourceStart.getTime()
            ) {
              isViolated = true;
              reason = `Blocker due date (${targetDue.toDateString()}) overlaps start (${sourceStart.toDateString()})`;
            } else if (
              !sourceStart &&
              sourceDue &&
              targetStart &&
              sourceDue.getTime() > targetStart.getTime()
            ) {
              isViolated = true;
              reason = `Due date (${sourceDue.toDateString()}) overlaps target start (${targetStart.toDateString()})`;
            }
            break;
          case 'start_to_start':
            if (
              sourceStart &&
              targetStart &&
              sourceStart.getTime() > targetStart.getTime()
            ) {
              isViolated = true;
              reason = `Predecessor start (${sourceStart.toDateString()}) exceeds successor start (${targetStart.toDateString()})`;
            }
            break;
          case 'starts_before':
            if (
              sourceStart &&
              targetStart &&
              sourceStart.getTime() >= targetStart.getTime()
            ) {
              isViolated = true;
              reason = `Must start before target (${targetStart.toDateString()}) but starts on ${sourceStart.toDateString()}`;
            }
            break;
          case 'starts_after':
            if (
              sourceStart &&
              targetStart &&
              sourceStart.getTime() <= targetStart.getTime()
            ) {
              isViolated = true;
              reason = `Must start after target (${targetStart.toDateString()}) but starts on ${sourceStart.toDateString()}`;
            }
            break;
          case 'finish_to_finish':
            if (
              sourceDue &&
              targetDue &&
              sourceDue.getTime() > targetDue.getTime()
            ) {
              isViolated = true;
              reason = `Predecessor due date (${sourceDue.toDateString()}) exceeds successor due date (${targetDue.toDateString()})`;
            }
            break;
          case 'finishes_before':
            if (
              sourceDue &&
              targetDue &&
              sourceDue.getTime() >= targetDue.getTime()
            ) {
              isViolated = true;
              reason = `Must finish before target (${targetDue.toDateString()}) but finishes on ${sourceDue.toDateString()}`;
            }
            break;
          case 'finishes_after':
            if (
              sourceDue &&
              targetDue &&
              sourceDue.getTime() <= targetDue.getTime()
            ) {
              isViolated = true;
              reason = `Must finish after target (${targetDue.toDateString()}) but finishes on ${sourceDue.toDateString()}`;
            }
            break;
          case 'start_to_finish':
            if (
              sourceStart &&
              targetDue &&
              sourceStart.getTime() > targetDue.getTime()
            ) {
              isViolated = true;
              reason = `Predecessor start (${sourceStart.toDateString()}) exceeds successor due date (${targetDue.toDateString()})`;
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
