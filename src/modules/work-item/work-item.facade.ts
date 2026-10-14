import { Injectable, Optional } from '@nestjs/common';
import { WorkItemPriority, EntityType } from '@prisma/client';
import { CoreRepository as WorkItemRepository } from './core/core.repository';
import {
  WorkItemWithRelations,
  WorkItemFilterOptions,
} from './core/types/work-item.types';
import { StateService } from './state/state.service';
import { WorkItemState } from './state/types/state.types';
import { AttachmentService } from './attachment/attachment.service';
import { AssignmentService } from './assignment/assignment.service';
import { RelationService } from './relation/relation.service';
import { HistoryService } from './history/history.service';

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
    state?: WorkItemState | null;
    priority: WorkItemPriority;
    projectId: string;
    createdAt: Date;
    updatedAt: Date;
  };
}

export type WorkItemFilter = WorkItemFilterOptions;

@Injectable()
export class WorkItemFacade {
  constructor(
    private readonly workItemRepository: WorkItemRepository,
    private readonly stateService: StateService,
    private readonly attachmentService: AttachmentService,
    @Optional() private readonly assignmentService?: AssignmentService,
    @Optional() private readonly relationService?: RelationService,
    @Optional() private readonly historyService?: HistoryService,
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

  // ── Core Work Item Queries & Stats ──────────────────────────────────────────

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

  // ── State & Workflow ────────────────────────────────────────────────────────

  async getProjectStates(projectId: string): Promise<WorkItemState[]> {
    const { states } = await this.stateService.getStates(projectId);
    return states;
  }

  // ── Assignments ─────────────────────────────────────────────────────────────

  async getWorkItemAssignees(workItemId: string, projectId?: string) {
    const item = await this.workItemRepository.findWorkItemById(workItemId);
    const resolvedProjectId = projectId || item?.projectId;
    if (this.assignmentService && resolvedProjectId) {
      const res = await this.assignmentService.getAssignees(
        resolvedProjectId,
        workItemId,
      );
      return res.assignees;
    }
    return item?.assignee ? [item.assignee] : [];
  }

  async assignWorkItem(
    projectId: string,
    workItemId: string,
    assigneeId: string | null | undefined,
    actorId?: string,
  ) {
    if (this.assignmentService) {
      return this.assignmentService.assignWorkItem(
        projectId,
        workItemId,
        assigneeId,
        actorId,
      );
    }
    return this.workItemRepository.updateWorkItem(workItemId, {
      assigneeId: assigneeId || null,
    });
  }

  // ── Relations (Dependencies) ────────────────────────────────────────────────

  async getWorkItemRelations(workItemId: string) {
    if (this.relationService) {
      return this.relationService.getWorkItemRelations(workItemId);
    }
    return { relations: [] };
  }

  // ── History & Audit ─────────────────────────────────────────────────────────

  async getWorkItemActivity(workItemId: string, sort: 'asc' | 'desc' = 'desc') {
    if (this.historyService) {
      return this.historyService.getActivity(workItemId, sort);
    }
    return { workItemId, total: 0, activities: [] };
  }

  // ── Attachments & Entity Links ──────────────────────────────────────────────

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
  type WorkItemState,
} from './state/types/state.types';
export { WORK_ITEM_REDIS_KEYS } from './common/constants/redis-keys.constant';
