import { Injectable } from '@nestjs/common';
import { WorkItemPriority, EntityType } from '@prisma/client';
import { WorkItemRepository } from './core/core.repository';
import {
  WorkItemWithRelations,
  WorkItemFilterOptions,
} from './core/types/work-item.types';
import { StateService } from './state/state.service';
import { WorkItemState } from './state/types/state.types';
import { AttachmentService } from './attachment/attachment.service';

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
  dueDate: Date | null;
  completed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkedWorkItemSummary {
  linkId: string;
  entityType: EntityType;
  entityId: string;
  description: string | null;
  createdAt: Date;
  workItem: {
    id: string;
    identifier: string | null;
    title: string;
    columnId: string;
    state?: any;
    priority: WorkItemPriority;
    projectId: string;
    createdAt: Date;
    updatedAt: Date;
  };
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
  getStateWorkItemCounts(projectId: string): Promise<Record<string, number>>;
  getStateGroupCounts(projectId: string): Promise<Record<string, number>>;
  getOverdueCount(projectId: string): Promise<number>;
  getWorkItemsByLinkedEntity(
    entityType: EntityType,
    entityId: string,
  ): Promise<LinkedWorkItemSummary[]>;
}

@Injectable()
export class WorkItemFacade implements IWorkItemFacade {
  constructor(
    private readonly workItemRepository: WorkItemRepository,
    private readonly stateService: StateService,
    private readonly attachmentService: AttachmentService,
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

  async getStateWorkItemCounts(
    projectId: string,
  ): Promise<Record<string, number>> {
    return this.stateService.getStateWorkItemCounts(projectId);
  }

  async getStateGroupCounts(
    projectId: string,
  ): Promise<Record<string, number>> {
    return this.workItemRepository.getStateGroupCounts(projectId);
  }

  async getOverdueCount(projectId: string): Promise<number> {
    return this.workItemRepository.getOverdueCount(projectId);
  }

  async getWorkItemsByLinkedEntity(
    entityType: EntityType,
    entityId: string,
  ): Promise<LinkedWorkItemSummary[]> {
    return this.attachmentService.getWorkItemsByLinkedEntity(
      entityType,
      entityId,
    );
  }
}

export {
  DEFAULT_WORK_ITEM_STATES,
  WorkItemState,
} from './state/types/state.types';
export { WORK_ITEM_REDIS_KEYS } from './core/constants/redis-keys.constant';
