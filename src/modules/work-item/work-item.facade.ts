import { Injectable } from '@nestjs/common';
import { TaskPriority } from '@prisma/client';
import { WorkItemRepository } from './core/core.repository';
import {
  WorkItemWithRelations,
  WorkItemFilterOptions,
} from './core/types/work-item.types';
import { StateService } from './state/state.service';
import { WorkItemState } from './state/types/state.types';

export interface WorkItemSummary {
  id: string;
  identifier: string | null;
  sequenceNumber: number | null;
  title: string;
  columnId: string;
  priority: TaskPriority;
  projectId: string;
  authorId: string;
  assigneeId: string | null;
  cycleId: string | null;
  dueDate: Date | null;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkItemFilter = WorkItemFilterOptions;

export interface IWorkItemFacade {
  getTaskById(idOrIdentifier: string): Promise<WorkItemSummary | null>;
  getProjectTasks(
    projectId: string,
    filter?: WorkItemFilter,
  ): Promise<WorkItemSummary[]>;
  getUserAssignedTasks(
    userId: string,
    projectId?: string,
  ): Promise<WorkItemSummary[]>;
  getProjectStates(projectId: string): Promise<WorkItemState[]>;
  countTasksByProject(projectId: string): Promise<number>;
}

@Injectable()
export class WorkItemFacade implements IWorkItemFacade {
  constructor(
    private readonly workItemRepository: WorkItemRepository,
    private readonly stateService: StateService,
  ) {}

  private toSummary(workItem: WorkItemWithRelations): WorkItemSummary {
    return {
      id: workItem.id,
      identifier: workItem.identifier,
      sequenceNumber: workItem.sequenceNumber,
      title: workItem.title,
      columnId: workItem.columnId,
      priority: workItem.priority,
      projectId: workItem.projectId,
      authorId: workItem.authorId,
      assigneeId: workItem.assigneeId,
      cycleId: workItem.cycleId,
      dueDate: workItem.dueDate,
      completed: workItem.completed,
      createdAt: workItem.createdAt,
      updatedAt: workItem.updatedAt,
    };
  }

  async getTaskById(idOrIdentifier: string): Promise<WorkItemSummary | null> {
    const task = await this.workItemRepository.findTaskById(idOrIdentifier);
    return task ? this.toSummary(task) : null;
  }

  async getProjectTasks(
    projectId: string,
    filter?: WorkItemFilter,
  ): Promise<WorkItemSummary[]> {
    const tasks = await this.workItemRepository.findProjectTasks(
      projectId,
      filter,
    );
    return tasks.map((workItem) => this.toSummary(workItem));
  }

  async getUserAssignedTasks(
    userId: string,
    projectId?: string,
  ): Promise<WorkItemSummary[]> {
    const tasks = await this.workItemRepository.findTasksByAssignee(
      userId,
      projectId,
    );
    return tasks.map((workItem) => this.toSummary(workItem));
  }

  async getProjectStates(projectId: string): Promise<WorkItemState[]> {
    const { states } = await this.stateService.getStates(projectId);
    return states;
  }

  async countTasksByProject(projectId: string): Promise<number> {
    return this.workItemRepository.countProjectTasks(projectId);
  }
}
