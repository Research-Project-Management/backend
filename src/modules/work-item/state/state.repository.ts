import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';
import { IStateRepository, WorkItemState } from './types/state.types';
import { parseWorkItemStates } from './utils/state.util';

@Injectable()
export class StateRepository implements IStateRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findProjectById(projectId: string) {
    return this.prismaService.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        taskColumns: true,
      },
    });
  }

  async findProjectStates(projectId: string): Promise<WorkItemState[]> {
    const project = await this.findProjectById(projectId);
    if (!project) return [];
    return parseWorkItemStates(project.taskColumns);
  }

  async saveProjectStates(
    projectId: string,
    states: WorkItemState[],
  ): Promise<WorkItemState[]> {
    await this.prismaService.project.update({
      where: { id: projectId },
      data: {
        taskColumns: states as unknown as Prisma.InputJsonValue,
      },
    });
    return states;
  }

  async countTasksByState(projectId: string): Promise<Record<string, number>> {
    const counts = await this.prismaService.task.groupBy({
      by: ['columnId'],
      where: {
        projectId,
        deletedAt: null,
      },
      _count: {
        id: true,
      },
    });

    const result: Record<string, number> = {};
    for (const item of counts) {
      result[item.columnId] = item._count.id;
    }
    return result;
  }

  async countTasksInState(projectId: string, stateId: string): Promise<number> {
    return this.prismaService.task.count({
      where: {
        projectId,
        columnId: stateId,
        deletedAt: null,
      },
    });
  }

  async migrateTasksToState(
    projectId: string,
    fromStateId: string,
    toStateId: string,
    isToCompleted: boolean,
  ): Promise<number> {
    const result = await this.prismaService.task.updateMany({
      where: {
        projectId,
        columnId: fromStateId,
        deletedAt: null,
      },
      data: {
        columnId: toStateId,
        completed: isToCompleted,
      },
    });
    return result.count;
  }

  async deleteStateWithTaskMigration(
    projectId: string,
    deletedStateId: string,
    fallbackStateId: string,
    updatedStates: WorkItemState[],
    isFallbackCompleted: boolean,
  ): Promise<void> {
    await this.prismaService.$transaction(async (transaction) => {
      // 1. Migrate tasks if deleting a state with tasks
      if (deletedStateId !== fallbackStateId) {
        await transaction.task.updateMany({
          where: {
            projectId,
            columnId: deletedStateId,
            deletedAt: null,
          },
          data: {
            columnId: fallbackStateId,
            completed: isFallbackCompleted,
          },
        });
      }

      // 2. Persist updated states to project taskColumns
      await transaction.project.update({
        where: { id: projectId },
        data: {
          taskColumns: updatedStates as unknown as Prisma.InputJsonValue,
        },
      });
    });
  }
}
