import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CoreRepository } from '@/modules/work-item/core/core.repository';
import { IdHandler } from './id.handler';
import type { WorkItemWithRelations } from '@/modules/work-item/core/types/core.types';

@Injectable()
export class CloneHandler {
  constructor(
    private readonly idHandler: IdHandler,
    private readonly coreRepository: CoreRepository,
  ) {}

  async buildCloneData(
    sourceWorkItem: WorkItemWithRelations,
    authorId: string,
    destinationProjectId?: string,
  ) {
    const targetProjectId = destinationProjectId || sourceWorkItem.projectId;
    const isSameProject = targetProjectId === sourceWorkItem.projectId;

    let targetColumnId = sourceWorkItem.columnId || sourceWorkItem.stateId;
    let isCompleted = sourceWorkItem.completed;

    if (!isSameProject) {
      const sourceState =
        sourceWorkItem.state ??
        (await this.coreRepository.findStateWithGroup(targetColumnId));

      const targetStates =
        (await this.coreRepository.findProjectStates(targetProjectId)) || [];

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
        isCompleted = matchedState.group === 'completed';
      } else if (sourceState) {
        isCompleted = sourceState.group === 'completed';
      }
    }

    const { identifier, sequenceNumber } =
      await this.idHandler.nextIdentifier(targetProjectId);

    const sourceLabels = Array.isArray(sourceWorkItem.labels)
      ? sourceWorkItem.labels
      : Array.isArray(sourceWorkItem.labelAssignments)
        ? sourceWorkItem.labelAssignments
            .map((la) => la.label?.name)
            .filter((n): n is string => Boolean(n))
        : [];

    const cloneData: Prisma.WorkItemUncheckedCreateInput & {
      labels?: string[];
    } = {
      title: `${sourceWorkItem.title} (Copy)`,
      content: sourceWorkItem.content ?? '',
      stateId: targetColumnId,
      rank: (sourceWorkItem.rank ?? 0) + 1,
      priority: sourceWorkItem.priority,
      identifier,
      sequenceNumber,
      labels: isSameProject ? sourceLabels : [],
      completed: isCompleted,
      startDate: sourceWorkItem.startDate,
      dueDate: sourceWorkItem.dueDate,
      projectId: targetProjectId,
      createdById: authorId,
      assigneeId: isSameProject ? sourceWorkItem.assigneeId || null : null,
      parentWorkItemId:
        isSameProject && sourceWorkItem.parentWorkItemId
          ? sourceWorkItem.parentWorkItemId
          : null,
    };

    return { cloneData, targetProjectId, isSameProject, identifier };
  }
}
