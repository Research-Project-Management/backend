import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdHandler } from './id.handler';

@Injectable()
export class CloneHandler {
  constructor(private readonly idHandler: IdHandler) {}

  async buildCloneData(
    sourceWorkItem: any,
    authorId: string,
    destinationProjectId?: string,
  ) {
    const targetProjectId = destinationProjectId || sourceWorkItem.projectId;
    const isSameProject = targetProjectId === sourceWorkItem.projectId;

    const { identifier, sequenceNumber } =
      await this.idHandler.nextIdentifier(targetProjectId);

    const cloneData: Prisma.WorkItemUncheckedCreateInput = {
      title: `${sourceWorkItem.title} (Copy)`,
      content: sourceWorkItem.content || sourceWorkItem.description || '',
      columnId: sourceWorkItem.columnId,
      rank: (sourceWorkItem.rank ?? 0) + 1,
      priority: sourceWorkItem.priority,
      identifier,
      sequenceNumber,
      labels: sourceWorkItem.labels || [],
      completed: sourceWorkItem.completed,
      startDate: sourceWorkItem.startDate,
      dueDate: sourceWorkItem.dueDate,
      projectId: targetProjectId,
      authorId: authorId,
      assigneeId: sourceWorkItem.assigneeId || null,
      cycleId: isSameProject && sourceWorkItem.cycleId ? sourceWorkItem.cycleId : null,
      parentWorkItemId: isSameProject && sourceWorkItem.parentWorkItemId ? sourceWorkItem.parentWorkItemId : null,
    };

    return { cloneData, targetProjectId, isSameProject, identifier };
  }
}

export const WorkItemCloneHandler = CloneHandler;
export type WorkItemCloneHandler = CloneHandler;
