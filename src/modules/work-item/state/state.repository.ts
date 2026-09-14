import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IStateRepository, StateGroup, WorkItemState, DEFAULT_WORK_ITEM_STATES } from './types/state.types';

@Injectable()
export class StateRepository implements IStateRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findProjectById(projectId: string) {
    return this.prismaService.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
      },
    });
  }

  async findProjectStates(projectId: string): Promise<WorkItemState[]> {
    let states = await this.prismaService.workItemState.findMany({
      where: { projectId },
      orderBy: { sequence: 'asc' },
    });

    if (states.length === 0) {
      await this.seedDefaultStates(projectId);
      states = await this.prismaService.workItemState.findMany({
        where: { projectId },
        orderBy: { sequence: 'asc' },
      });
    }

    return states.map((s) => ({
      id: s.id,
      name: s.name,
      title: s.name,
      color: s.color,
      accentColor: s.color,
      group: s.group as StateGroup,
      sequence: s.sequence,
      isDefault: s.isDefault,
      description: s.description || undefined,
    }));
  }

  async seedDefaultStates(projectId: string): Promise<void> {
    for (const s of DEFAULT_WORK_ITEM_STATES) {
      await this.prismaService.workItemState.create({
        data: {
          name: s.name,
          color: s.color,
          group: s.group,
          sequence: s.sequence,
          isDefault: s.isDefault,
          description: s.description || '',
          projectId,
        },
      });
    }
  }

  async saveProjectStates(
    projectId: string,
    states: WorkItemState[],
  ): Promise<WorkItemState[]> {
    await this.prismaService.$transaction(
      states.map((s) =>
        this.prismaService.workItemState.upsert({
          where: {
            id: s.id,
          },
          update: {
            name: s.name,
            color: s.color,
            group: s.group,
            sequence: s.sequence,
            isDefault: s.isDefault ?? false,
            description: s.description || '',
          },
          create: {
            id: s.id,
            name: s.name,
            color: s.color,
            group: s.group,
            sequence: s.sequence,
            isDefault: s.isDefault ?? false,
            description: s.description || '',
            projectId,
          },
        }),
      ),
    );
    return states;
  }

  async countWorkItemsByState(
    projectId: string,
  ): Promise<Record<string, number>> {
    const counts = await this.prismaService.workItem.groupBy({
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

  async countWorkItemsInState(
    projectId: string,
    stateId: string,
  ): Promise<number> {
    return this.prismaService.workItem.count({
      where: {
        projectId,
        columnId: stateId,
        deletedAt: null,
      },
    });
  }

  async migrateWorkItemsToState(
    projectId: string,
    fromStateId: string,
    toStateId: string,
    isToCompleted: boolean,
  ): Promise<number> {
    const result = await this.prismaService.workItem.updateMany({
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

  async deleteStateWithWorkItemMigration(
    projectId: string,
    deletedStateId: string,
    fallbackStateId: string,
    updatedStates: WorkItemState[],
    isFallbackCompleted: boolean,
  ): Promise<void> {
    await this.prismaService.$transaction(async (transaction) => {
      // 1. Migrate work items if deleting a state with work items
      if (deletedStateId !== fallbackStateId) {
        await transaction.workItem.updateMany({
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

      // 2. Delete state record directly from work_item_states
      await transaction.workItemState.deleteMany({
        where: {
          id: deletedStateId,
          projectId,
        },
      });

      // 3. Update sequences of remaining states if necessary
      for (const state of updatedStates) {
        await transaction.workItemState.updateMany({
          where: { id: state.id, projectId },
          data: {
            sequence: state.sequence,
            isDefault: state.isDefault,
          },
        });
      }
    });
  }
}
