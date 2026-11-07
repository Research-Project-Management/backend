import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { WorkItem, WorkItemRelationType } from '@prisma/client';
import {
  buildWorkItemIdOrIdentifierWhere,
  resolveCanonicalProjectId as resolveSharedProjectId,
} from '@/modules/work-item/common/types/shared.types';

export type WorkItemWithRelationalLinks = WorkItem & {
  columnId: string;
  authorId: string;
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

  async resolveCanonicalProjectId(projectId: string): Promise<string | null> {
    return resolveSharedProjectId(this.prismaService, projectId);
  }

  async findProjectWorkItemsForCpm(
    projectId: string,
  ): Promise<WorkItemWithRelationalLinks[]> {
    const canonicalProjectId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalProjectId) return [];
    const items = await this.prismaService.workItem.findMany({
      where: {
        projectId: canonicalProjectId,
        deletedAt: null,
        archivedAt: null,
      },
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
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    });
    return items.map((item) => ({
      ...item,
      columnId: item.stateId,
      authorId: item.createdById,
    }));
  }

  async findWorkItem(
    workItemId: string,
  ): Promise<WorkItemWithRelationalLinks | null> {
    const item = await this.prismaService.workItem.findFirst({
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
    if (!item) return null;
    return {
      ...item,
      columnId: item.stateId,
      authorId: item.createdById,
    };
  }

  async findWorkItemsByIds(
    workItemIds: string[],
  ): Promise<Array<WorkItem & { columnId: string; authorId: string }>> {
    if (!workItemIds || workItemIds.length === 0) return [];
    const items = await this.prismaService.workItem.findMany({
      where: {
        id: { in: workItemIds },
        deletedAt: null,
      },
    });
    return items.map((item) => ({
      ...item,
      columnId: item.stateId,
      authorId: item.createdById,
    }));
  }

  async findProjectGraphEdges(
    projectId: string,
    relationCategory: 'blocks' | 'duplicate_of',
  ): Promise<Array<{ sourceId: string; targetId: string }>> {
    const edges: Array<{ sourceId: string; targetId: string }> = [];
    const isBlocks = relationCategory === 'blocks';
    const inverseTypes = isBlocks
      ? ['blocked_by', 'starts_after', 'finishes_after']
      : ['duplicated_by'];

    const prismaRelationTypes: WorkItemRelationType[] = isBlocks
      ? [WorkItemRelationType.blocks, WorkItemRelationType.blocked_by]
      : [WorkItemRelationType.duplicate_of];

    const dbRelations = await this.prismaService.workItemRelation.findMany({
      where: {
        sourceWorkItem: { projectId, deletedAt: null },
        targetWorkItem: { projectId, deletedAt: null },
        type: { in: prismaRelationTypes },
      },
      select: { sourceId: true, targetId: true, type: true },
    });

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

    return edges;
  }
}
