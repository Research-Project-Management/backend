import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { WorkItem, Prisma } from '@prisma/client';
import { IRelationRepository } from './types/relation.types';
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
}
