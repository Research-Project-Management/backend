import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdHandler } from './id.handler';

@Injectable()
export class CloneHandler {
  constructor(private readonly idHandler: IdHandler) {}

  async buildCloneData(
    sourceTask: any,
    authorId: string,
    destinationProjectId?: string,
  ) {
    const targetProjectId = destinationProjectId || sourceTask.projectId;
    const isSameProject = targetProjectId === sourceTask.projectId;

    const { identifier, sequenceNumber } =
      await this.idHandler.nextIdentifier(targetProjectId);

    const cloneData: Prisma.WorkItemCreateInput = {
      title: `${sourceTask.title} (Copy)`,
      content: sourceTask.content || sourceTask.description || '',
      columnId: sourceTask.columnId,
      rank: (sourceTask.rank ?? 0) + 1,
      priority: sourceTask.priority,
      identifier,
      sequenceNumber,
      labels: sourceTask.labels || [],
      completed: sourceTask.completed,
      startDate: sourceTask.startDate,
      dueDate: sourceTask.dueDate,
      project: { connect: { id: targetProjectId } },
      author: { connect: { id: authorId } },
      ...(sourceTask.assigneeId
        ? { assignee: { connect: { id: sourceTask.assigneeId } } }
        : {}),
      ...(isSameProject && sourceTask.cycleId
        ? { cycle: { connect: { id: sourceTask.cycleId } } }
        : {}),
      ...(isSameProject && sourceTask.parentTaskId
        ? { parentTask: { connect: { id: sourceTask.parentTaskId } } }
        : {}),
    };

    return { cloneData, targetProjectId, isSameProject, identifier };
  }
}

export const WorkItemCloneHandler = CloneHandler;
export type WorkItemCloneHandler = CloneHandler;
