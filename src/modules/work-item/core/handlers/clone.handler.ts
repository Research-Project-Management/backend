import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import { CoreRepository } from '../core.repository';
import { IdHandler } from './id.handler';
import type { WorkItemWithRelations } from '../types/work-item.types';

@Injectable()
export class CloneHandler {
  constructor(
    private readonly idHandler: IdHandler,
    private readonly repository: CoreRepository,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async buildCloneData(
    sourceWorkItem: WorkItemWithRelations,
    authorId: string,
    destinationProjectId?: string,
  ) {
    const targetProjectId = destinationProjectId || sourceWorkItem.projectId;
    const isSameProject = targetProjectId === sourceWorkItem.projectId;

    let targetColumnId = sourceWorkItem.columnId;
    if (!isSameProject) {
      const sourceState = this.repository?.findStateWithGroup
        ? await this.repository.findStateWithGroup(sourceWorkItem.columnId)
        : await this.prisma?.workItemState.findUnique({
            where: { id: sourceWorkItem.columnId },
            select: { group: true, name: true },
          });

      const targetStates =
        (this.repository?.findProjectStates
          ? await this.repository.findProjectStates(targetProjectId)
          : await this.prisma?.workItemState.findMany({
              where: { projectId: targetProjectId },
              orderBy: { sequence: 'asc' },
            })) || [];

      const matchedState =
        targetStates.find(
          (s) => sourceState && s.group === sourceState.group,
        ) ||
        targetStates.find(
          (s) =>
            sourceState &&
            s.name.toLowerCase() === sourceState.name.toLowerCase(),
        ) ||
        targetStates.find((s) => s.isDefault) ||
        targetStates[0];

      if (matchedState) {
        targetColumnId = matchedState.id;
      }
    }

    const { identifier, sequenceNumber } =
      await this.idHandler.nextIdentifier(targetProjectId);

    let isCompleted = sourceWorkItem.completed;
    if (!isSameProject && targetColumnId) {
      const stateObj = this.repository?.findStateWithGroup
        ? await this.repository.findStateWithGroup(targetColumnId)
        : await this.prisma?.workItemState.findUnique({
            where: { id: targetColumnId },
            select: { group: true },
          });
      if (stateObj) {
        isCompleted = stateObj.group === 'completed';
      }
    }

    const cloneData: Prisma.WorkItemUncheckedCreateInput = {
      title: `${sourceWorkItem.title} (Copy)`,
      content: sourceWorkItem.content ?? '',
      columnId: targetColumnId,
      rank: (sourceWorkItem.rank ?? 0) + 1,
      priority: sourceWorkItem.priority,
      identifier,
      sequenceNumber,
      labels: isSameProject ? sourceWorkItem.labels || [] : [],
      completed: isCompleted,
      startDate: sourceWorkItem.startDate,
      dueDate: sourceWorkItem.dueDate,
      projectId: targetProjectId,
      authorId: authorId,
      assigneeId: isSameProject ? sourceWorkItem.assigneeId || null : null,
      parentWorkItemId:
        isSameProject && sourceWorkItem.parentWorkItemId
          ? sourceWorkItem.parentWorkItemId
          : null,
    };

    return { cloneData, targetProjectId, isSameProject, identifier };
  }
}

export const WorkItemCloneHandler = CloneHandler;
export type WorkItemCloneHandler = CloneHandler;
