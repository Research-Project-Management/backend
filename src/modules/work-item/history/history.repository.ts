import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType } from '@prisma/client';

@Injectable()
export class HistoryRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findTaskWithProject(taskId: string) {
    return this.prismaService.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        columnId: true,
        completed: true,
        createdAt: true,
        projectId: true,
        project: {
          select: {
            id: true,
            identifier: true,
            taskColumns: true,
          },
        },
      },
    });
  }

  async findTaskComments(taskId: string, sort: 'asc' | 'desc' = 'desc') {
    return this.prismaService.taskComment.findMany({
      where: { taskId },
      orderBy: { createdAt: sort },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findTaskActivityEvents(taskId: string, sort: 'asc' | 'desc' = 'desc') {
    return this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.task,
        entityId: taskId,
      },
      orderBy: { createdAt: sort },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findStateTransitions(taskId: string) {
    return this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.task,
        entityId: taskId,
        OR: [
          { verb: 'transitioned' },
          { field: 'state' },
          { field: 'columnId' },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findHistoryEvents(taskId: string, sort: 'asc' | 'desc' = 'desc') {
    return this.prismaService.activityEvent.findMany({
      where: {
        entityType: EntityType.task,
        entityId: taskId,
        field: { not: null },
      },
      orderBy: { createdAt: sort },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findTaskWorklogs(taskId: string, sort: 'asc' | 'desc' = 'desc') {
    return this.prismaService.worklog.findMany({
      where: { taskId },
      orderBy: { createdAt: sort },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }
}
