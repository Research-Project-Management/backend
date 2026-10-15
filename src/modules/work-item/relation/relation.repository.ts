import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { WorkItem, Prisma, WorkItemRelationType } from '@prisma/client';
import { WorkItemRelationItem } from './types/relation.types';
import { buildWorkItemIdOrIdentifierWhere } from '@/modules/work-item/common/types/shared.types';

@Injectable()
export class RelationRepository {
  constructor(private readonly prismaService: PrismaService) {}

  get prisma(): PrismaService {
    return this.prismaService;
  }

  async findWorkItem(workItemId: string): Promise<WorkItem | null> {
    return this.prismaService.workItem.findFirst({
      where: buildWorkItemIdOrIdentifierWhere(workItemId),
    });
  }

  async findWorkItemsByIds(workItemIds: string[]): Promise<WorkItem[]> {
    if (!workItemIds || workItemIds.length === 0) return [];
    return this.prismaService.workItem.findMany({
      where: {
        id: { in: workItemIds },
        deletedAt: null,
      },
    });
  }

  async findProjectGraphEdges(
    projectId: string,
    relationCategory: 'blocks' | 'duplicate_of',
  ): Promise<Array<{ sourceId: string; targetId: string }>> {
    const edges: Array<{ sourceId: string; targetId: string }> = [];
    const isBlocks = relationCategory === 'blocks';
    const forwardTypes = isBlocks
      ? [
          'blocks',
          'finish_to_start',
          'FINISH_TO_START',
          'start_to_start',
          'START_TO_START',
          'finish_to_finish',
          'FINISH_TO_FINISH',
          'start_to_finish',
          'START_TO_FINISH',
          'starts_before',
          'finishes_before',
        ]
      : ['duplicate_of'];
    const inverseTypes = isBlocks
      ? ['blocked_by', 'starts_after', 'finishes_after']
      : ['duplicated_by'];

    const prismaRelationTypes: WorkItemRelationType[] = isBlocks
      ? [WorkItemRelationType.blocks, WorkItemRelationType.blocked_by]
      : [WorkItemRelationType.duplicate_of];

    const [dbRelations, items] = await Promise.all([
      this.prismaService.workItemRelation.findMany({
        where: {
          sourceWorkItem: { projectId, deletedAt: null },
          targetWorkItem: { projectId, deletedAt: null },
          type: { in: prismaRelationTypes },
        },
        select: { sourceId: true, targetId: true, type: true },
      }),
      this.prismaService.workItem.findMany({
        where: {
          projectId,
          deletedAt: null,
          relations: { not: Prisma.DbNull },
        },
        select: { id: true, relations: true },
      }),
    ]);

    for (const rel of dbRelations as Array<{
      sourceId: string;
      targetId: string;
      type?: string;
    }>) {
      if (rel.type && inverseTypes.includes(rel.type)) {
        edges.push({ sourceId: rel.targetId, targetId: rel.sourceId });
      } else {
        edges.push({ sourceId: rel.sourceId, targetId: rel.targetId });
      }
    }

    for (const item of items) {
      if (Array.isArray(item.relations)) {
        for (const r of item.relations as unknown as WorkItemRelationItem[]) {
          if (!r.targetWorkItemId) continue;
          if (forwardTypes.includes(r.type)) {
            edges.push({ sourceId: item.id, targetId: r.targetWorkItemId });
          } else if (inverseTypes.includes(r.type)) {
            edges.push({ sourceId: r.targetWorkItemId, targetId: item.id });
          }
        }
      }
    }

    return edges;
  }
}
