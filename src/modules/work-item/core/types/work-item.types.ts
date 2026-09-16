/**
 * WorkItem Domain Types & Interfaces
 *
 * Hexagonal / DDD-Lite ports and domain model definitions.
 * Integrated with Attach Center (Pages, Papers, Files, Links).
 */

import { WorkItem, WorkItemPriority, Prisma } from '@prisma/client';
import type { WorkItemUpdate } from '../../update/types/update.types';

export { WorkItemPriority };

export const USER_MINIMAL_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export const CYCLE_SELECT = {
  id: true,
  name: true,
} as const;

export const STATE_MINIMAL_SELECT = {
  id: true,
  name: true,
  color: true,
  group: true,
  sequence: true,
  isDefault: true,
} as const;

export const CHILD_WORK_ITEM_SELECT = {
  id: true,
  title: true,
  identifier: true,
  columnId: true,
  completed: true,
  rank: true,
  assigneeId: true,
  assignee: { select: USER_MINIMAL_SELECT },
  state: { select: STATE_MINIMAL_SELECT },
  dueDate: true,
} as const;

export interface UserMinimal {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export interface StateMinimal {
  id: string;
  name: string;
  color: string;
  group: string;
  sequence: number;
  isDefault: boolean;
}

export interface CycleMinimal {
  id: string;
  name: string;
}

export interface ChildWorkItemMinimal {
  id: string;
  title: string;
  identifier: string | null;
  columnId: string;
  completed: boolean;
  stateGroup?: string;
  rank: number;
  assigneeId: string | null;
  assignee?: UserMinimal | null;
  state?: StateMinimal | null;
  dueDate?: Date | string | null;
}

export interface ParentWorkItemMinimal {
  id: string;
  title: string;
  identifier: string | null;
}

/**
 * Minimal label shape returned on work items.
 * Matches the Label Prisma model subset.
 */
export interface LabelMinimal {
  id: string;
  name: string;
  color: string;
}

// ── FLUX ATTACH CENTER TYPES ────────────────────────────────────────────────

export interface AttachPageItem {
  id: string;
  title: string;
  slug?: string | null;
  addedAt: string;
}

export interface AttachPaperItem {
  id: string;
  title: string;
  doi?: string | null;
  citationKey?: string | null;
  addedAt: string;
}

export interface AttachFileItem {
  id: string;
  name: string;
  url: string;
  size?: number | null;
  type?: string | null;
  uploadedAt: string;
}

export interface AttachLinkItem {
  title: string;
  url: string;
  addedAt: string;
}

export interface WorkItemAttachments {
  pages?: AttachPageItem[];
  papers?: AttachPaperItem[];
  files?: AttachFileItem[];
  links?: AttachLinkItem[];
}

export type WorkItemWithRelations = Prisma.WorkItemGetPayload<{
  include: {
    state: { select: typeof STATE_MINIMAL_SELECT };
    assignee: { select: typeof USER_MINIMAL_SELECT };
    assignees: {
      select: {
        isPrimary: true;
        user: { select: typeof USER_MINIMAL_SELECT };
      };
    };
    labelAssignments: {
      select: {
        label: { select: { id: true; name: true; color: true } };
      };
    };
    cycle: { select: typeof CYCLE_SELECT };
    parentWorkItem: { select: { id: true; title: true; identifier: true } };
    childWorkItems: {
      select: typeof CHILD_WORK_ITEM_SELECT;
    };
    project: { select: { id: true } };
  };
}>;

export interface WorkItemResponse {
  id: string;
  identifier?: string | null;
  sequenceNumber?: number | null;
  title: string;
  content: string;
  description: string;
  columnId: string;
  state?: StateMinimal | null;
  stateGroup?: string;
  progressPercentage?: number;
  priority: WorkItemPriority;
  relations?: Prisma.JsonValue;
  startDate?: string | null;
  dueDate?: string | null;
  labels: LabelMinimal[];
  labelIds?: string[];
  attachments?: WorkItemAttachments | Prisma.JsonValue;
  completed: boolean;
  rank: number;
  timeSpent?: number | null;
  projectId: string;
  authorId: string;
  assigneeId?: string | null;
  assigneeIds?: string[];
  assignees?: UserMinimal[];
  subscriberIds?: string[];
  cycleId?: string | null;
  parentWorkItemId?: string | null;
  parentWorkItem?: ParentWorkItemMinimal | null;
  childWorkItems?: ChildWorkItemMinimal[];
  childWorkItemCount?: number;
  childWorkItemCompletedCount?: number;
  assignee?: UserMinimal | null;
  cycle?: CycleMinimal | string | null;
  updates?: WorkItemUpdate[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemFilterOptions {
  cycleId?: string | string[] | null;
  cycle?: string | string[] | null;
  columnId?: string | string[];
  state?: string | string[];
  stateGroup?: string | string[];
  priority?: WorkItemPriority | WorkItemPriority[];
  assigneeId?: string | string[] | null;
  assignees?: string | string[] | null;
  labels?: string | string[];
  createdById?: string | string[];
  authorId?: string | string[];
  parentWorkItemId?: string | null;
  dueDate?: string;
  startDate?: string;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  completed?: boolean;
  archived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface IWorkItemRepository {
  findProjectWorkItems(
    projectId: string,
    filter?: string | WorkItemFilterOptions,
  ): Promise<WorkItemWithRelations[]>;
  findWorkItemById(workItemId: string): Promise<WorkItemWithRelations | null>;
  findWorkItemByIdentifier(
    projectId: string,
    identifier: string,
  ): Promise<WorkItemWithRelations | null>;
  nextProjectWorkItemIdentifier(
    projectId: string,
  ): Promise<{ identifier: string; sequenceNumber: number }>;
  createWorkItem(
    data: Prisma.WorkItemCreateInput | Prisma.WorkItemUncheckedCreateInput,
  ): Promise<WorkItemWithRelations>;
  updateWorkItem(
    workItemId: string,
    data: Prisma.WorkItemUpdateInput | Prisma.WorkItemUncheckedUpdateInput,
  ): Promise<WorkItemWithRelations>;
  softDeleteWorkItem(workItemId: string): Promise<WorkItem>;
  restoreWorkItem(workItemId: string): Promise<WorkItem>;
  deleteWorkItem(workItemId: string): Promise<WorkItem>;
  findWorkItemsByIds(workItemIds: string[]): Promise<WorkItem[]>;
  bulkUpdateWorkItems(
    projectId: string,
    workItemIds: string[],
    data: Prisma.WorkItemUpdateManyMutationInput & {
      assigneeId?: string | null;
      cycleId?: string | null;
    },
  ): Promise<{ count: number }>;
  updateWorkItemsRank(
    updates: Array<{
      id: string;
      rank: number;
      columnId?: string;
      completed?: boolean;
    }>,
  ): Promise<WorkItem[]>;
  findProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<string | null>;
  saveInitialAttachments(
    workItemId: string,
    projectId: string,
    authorId: string,
    attachments: any,
  ): Promise<void>;
  syncAttachments(
    workItemId: string,
    projectId: string,
    authorId?: string,
    attachments?: any,
  ): Promise<void>;
  countProjectWorkItems(projectId: string): Promise<number>;
  disconnectParentWorkItem(workItemId: string): Promise<WorkItemWithRelations>;
  findWorkItemsByAssignee(
    userId: string,
    projectId?: string,
    take?: number,
    skip?: number,
  ): Promise<WorkItemWithRelations[]>;
}
