import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { WorkItem, Prisma, WorkItemRelationType } from '@prisma/client';
import { WorkItemRelationItem } from './types/relation.types';
import { buildWorkItemIdOrIdentifierWhere } from '@/modules/work-item/common/types/shared.types';

export type WorkItemWithRelationalLinks = WorkItem & {
  outgoingRelations?: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: WorkItemRelationType | string;
    createdAt: Date;
  }>;
  incomingRelations?: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: WorkItemRelationType | string;
    createdAt: Date;
  }>;
};

@Injectable()
export class RelationRepository {
  constructor(private readonly prismaService: PrismaService) {}

  get prisma(): PrismaService {
    return this.prismaService;
  }

  async findWorkItem(
    workItemId: string,
  ): Promise<WorkItemWithRelationalLinks | null> {
    return this.prismaService.workItem.findFirst({
      where: buildWorkItemIdOrIdentifierWhere(workItemId),
      include: {
        outgoingRelations: {
          where: { targetWorkItem: { deletedAt: null } },
          select: {
            id: true,
            sourceId: true,
            targetId: true,
            type: true,
            createdAt: true,
          },
        },
        incomingRelations: {
          where: { sourceWorkItem: { deletedAt: null } },
          select: {
            id: true,
            sourceId: true,
            targetId: true,
            type: true,
            createdAt: true,
          },
        },
      },
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
          'start_to_start',
          'finish_to_finish',
          'start_to_finish',
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
      const normalizedRelType = rel.type?.toLowerCase();
      if (normalizedRelType && inverseTypes.includes(normalizedRelType)) {
        edges.push({ sourceId: rel.targetId, targetId: rel.sourceId });
      } else {
        edges.push({ sourceId: rel.sourceId, targetId: rel.targetId });
      }
    }

    for (const item of items) {
      if (Array.isArray(item.relations)) {
        for (const r of item.relations as unknown as WorkItemRelationItem[]) {
          if (!r.targetWorkItemId) continue;
          const normalizedType = String(r.type || '').toLowerCase();
          if (forwardTypes.includes(normalizedType)) {
            edges.push({ sourceId: item.id, targetId: r.targetWorkItemId });
          } else if (inverseTypes.includes(normalizedType)) {
            edges.push({ sourceId: r.targetWorkItemId, targetId: item.id });
          }
        }
      }
    }

    return edges;
  }
}
