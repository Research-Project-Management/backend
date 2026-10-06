import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { WorkItem, Prisma } from '@prisma/client';
import {
  IRelationRepository,
  WorkItemRelationItem,
} from './types/relation.types';
import { isUuid } from '@/core/utils/uuid.util';

@Injectable()
export class RelationRepository implements IRelationRepository {
  constructor(private readonly prismaService: PrismaService) {}

  get prisma(): PrismaService {
    return this.prismaService;
  }

  async findWorkItem(workItemId: string): Promise<WorkItem | null> {
    if (isUuid(workItemId)) {
      return this.prismaService.workItem.findFirst({
        where: { id: workItemId, deletedAt: null },
      });
    }
    return this.prismaService.workItem.findFirst({
      where: { identifier: workItemId, deletedAt: null },
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

  async updateWorkItemRelations(
    workItemId: string,
    relations: Prisma.InputJsonValue,
  ): Promise<WorkItem> {
    return this.prismaService.workItem.update({
      where: { id: workItemId },
      data: { relations },
    });
  }

  async executeTransaction(operations: any[]): Promise<any> {
    return this.prismaService.$transaction(operations);
  }

  async findProjectGraphEdges(
    projectId: string,
    relationCategory: 'blocks' | 'duplicate_of',
  ): Promise<Array<{ sourceId: string; targetId: string }>> {
    const edges: Array<{ sourceId: string; targetId: string }> = [];

    if (relationCategory === 'blocks') {
      const [dbRelations, items] = await Promise.all([
        this.prismaService.workItemRelation.findMany({
          where: {
            sourceWorkItem: { projectId, deletedAt: null },
            targetWorkItem: { projectId, deletedAt: null },
            type: { in: ['blocks', 'blocked_by'] },
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

      for (const rel of dbRelations) {
        if (rel.type === 'blocks') {
          edges.push({ sourceId: rel.sourceId, targetId: rel.targetId });
        } else if (rel.type === 'blocked_by') {
          edges.push({ sourceId: rel.targetId, targetId: rel.sourceId });
        }
      }

      for (const item of items) {
        if (Array.isArray(item.relations)) {
          for (const r of item.relations as unknown as WorkItemRelationItem[]) {
            if (r.type === 'blocks' && r.targetWorkItemId) {
              edges.push({ sourceId: item.id, targetId: r.targetWorkItemId });
            } else if (r.type === 'blocked_by' && r.targetWorkItemId) {
              edges.push({ sourceId: r.targetWorkItemId, targetId: item.id });
            }
          }
        }
      }
    } else if (relationCategory === 'duplicate_of') {
      const [dbRelations, items] = await Promise.all([
        this.prismaService.workItemRelation.findMany({
          where: {
            sourceWorkItem: { projectId, deletedAt: null },
            targetWorkItem: { projectId, deletedAt: null },
            type: 'duplicate_of',
          },
          select: { sourceId: true, targetId: true },
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

      for (const rel of dbRelations) {
        edges.push({ sourceId: rel.sourceId, targetId: rel.targetId });
      }

      for (const item of items) {
        if (Array.isArray(item.relations)) {
          for (const r of item.relations as unknown as WorkItemRelationItem[]) {
            if (r.type === 'duplicate_of' && r.targetWorkItemId) {
              edges.push({ sourceId: item.id, targetId: r.targetWorkItemId });
            }
          }
        }
      }
    }

    return edges;
  }
}
