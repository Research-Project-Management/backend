import { Injectable } from '@nestjs/common';
import { WorkItemPriority } from '@prisma/client';
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
  priority: WorkItemPriority;
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
  getWorkItemById(idOrIdentifier: string): Promise<WorkItemSummary | null>;
  getProjectWorkItems(
    projectId: string,
    filter?: WorkItemFilter,
  ): Promise<WorkItemSummary[]>;
  getUserAssignedWorkItems(
    userId: string,
    projectId?: string,
  ): Promise<WorkItemSummary[]>;
  getProjectStates(projectId: string): Promise<WorkItemState[]>;
  countWorkItemsByProject(projectId: string): Promise<number>;
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

  async getWorkItemById(
    idOrIdentifier: string,
  ): Promise<WorkItemSummary | null> {
    const item = await this.workItemRepository.findWorkItemById(idOrIdentifier);
    return item ? this.toSummary(item) : null;
  }

  async getProjectWorkItems(
    projectId: string,
    filter?: WorkItemFilter,
  ): Promise<WorkItemSummary[]> {
    const items = await this.workItemRepository.findProjectWorkItems(
      projectId,
      filter,
    );
    return items.map((workItem) => this.toSummary(workItem));
  }

  async getUserAssignedWorkItems(
    userId: string,
    projectId?: string,
  ): Promise<WorkItemSummary[]> {
    const items = await this.workItemRepository.findWorkItemsByAssignee(
      userId,
      projectId,
    );
    return items.map((workItem) => this.toSummary(workItem));
  }

  async getProjectStates(projectId: string): Promise<WorkItemState[]> {
    const { states } = await this.stateService.getStates(projectId);
    return states;
  }

  async countWorkItemsByProject(projectId: string): Promise<number> {
    return this.workItemRepository.countProjectWorkItems(projectId);
  }
}
