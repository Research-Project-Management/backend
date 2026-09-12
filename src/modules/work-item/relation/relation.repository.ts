import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Task, Prisma } from '@prisma/client';
import { IRelationRepository } from './types/relation.types';
import { isUuid } from '@/core/utils/tenant.util';

@Injectable()
export class RelationRepository implements IRelationRepository {
  constructor(private readonly prismaService: PrismaService) {}

  get prisma(): PrismaService {
    return this.prismaService;
  }

  async findTask(taskId: string): Promise<Task | null> {
    if (isUuid(taskId)) {
      return this.prismaService.task.findFirst({
        where: { id: taskId, deletedAt: null },
      });
    }
    return this.prismaService.task.findFirst({
      where: { identifier: taskId, deletedAt: null },
    });
  }

  async findTasksByIds(taskIds: string[]): Promise<Task[]> {
    if (!taskIds || taskIds.length === 0) return [];
    return this.prismaService.task.findMany({
      where: {
        id: { in: taskIds },
        deletedAt: null,
      },
    });
  }

  async updateTaskRelations(
    taskId: string,
    relations: Prisma.InputJsonValue,
  ): Promise<Task> {
    return this.prismaService.task.update({
      where: { id: taskId },
      data: { relations },
    });
  }

  async executeTransaction(operations: any[]): Promise<any> {
    return this.prismaService.$transaction(operations);
  }
}
