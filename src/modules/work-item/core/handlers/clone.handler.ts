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

    const cloneData: Prisma.WorkItemCreateInput = {
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
      project: { connect: { id: targetProjectId } },
      author: { connect: { id: authorId } },
      ...(sourceWorkItem.assigneeId
        ? { assignee: { connect: { id: sourceWorkItem.assigneeId } } }
        : {}),
      ...(isSameProject && sourceWorkItem.cycleId
        ? { cycle: { connect: { id: sourceWorkItem.cycleId } } }
        : {}),
      ...(isSameProject && sourceWorkItem.parentWorkItemId
        ? { parentWorkItem: { connect: { id: sourceWorkItem.parentWorkItemId } } }
        : {}),
    };

    return { cloneData, targetProjectId, isSameProject, identifier };
  }
}

export const WorkItemCloneHandler = CloneHandler;
export type WorkItemCloneHandler = CloneHandler;
