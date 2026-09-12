/**
 * WorkItem Domain Types & Interfaces
 *
 * Hexagonal / DDD-Lite ports and domain model definitions.
 * Integrated with Attach Center (Pages, Papers, Files, Links) replacing Modules.
 */

import { WorkItem, TaskPriority, Prisma } from '@prisma/client';
import type { WorkItemUpdate } from '../../update/types/update.types';

export type WorkItemPriority = TaskPriority;
export const WorkItemPriority = TaskPriority;

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

export const SUBTASK_SELECT = {
  id: true,
  title: true,
  identifier: true,
  columnId: true,
  completed: true,
  rank: true,
  assigneeId: true,
  assignee: { select: USER_MINIMAL_SELECT },
  dueDate: true,
} as const;

export interface UserMinimal {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export interface CycleMinimal {
  id: string;
  name: string;
}

export interface SubtaskMinimal {
  id: string;
  title: string;
  identifier: string | null;
  columnId: string;
  completed: boolean;
  rank: number;
  assigneeId: string | null;
  assignee?: UserMinimal | null;
  dueDate?: Date | string | null;
}

export interface ParentTaskMinimal {
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
    assignee: { select: typeof USER_MINIMAL_SELECT };
    cycle: { select: typeof CYCLE_SELECT };
    parentTask: { select: { id: true; title: true; identifier: true } };
    subtasks: {
      select: typeof SUBTASK_SELECT;
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
  parentTaskId?: string | null;
  parentTask?: ParentTaskMinimal | null;
  subtasks?: SubtaskMinimal[];
  subtaskCount?: number;
  subtaskCompletedCount?: number;
  assignee?: UserMinimal | null;
  cycle?: CycleMinimal | string | null;
  updates?: WorkItemUpdate[];
  createdAt: string;
  updatedAt: string;
}

export type TaskResponse = WorkItemResponse;

export interface WorkItemFilterOptions {
  cycleId?: string | null;
  columnId?: string;
  priority?: WorkItemPriority;
  assigneeId?: string | null;
  parentTaskId?: string | null;
  completed?: boolean;
  archived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface IWorkItemRepository {
  findProjectTasks(
    projectId: string,
    filter?: string | WorkItemFilterOptions,
  ): Promise<WorkItemWithRelations[]>;
  findTaskById(taskId: string): Promise<WorkItemWithRelations | null>;
  findTaskByIdentifier(
    projectId: string,
    identifier: string,
  ): Promise<WorkItemWithRelations | null>;
  nextProjectTaskIdentifier(
    projectId: string,
  ): Promise<{ identifier: string; sequenceNumber: number }>;
  createTask(
    data: Prisma.WorkItemCreateInput | Prisma.WorkItemUncheckedCreateInput,
  ): Promise<WorkItemWithRelations>;
  updateTask(
    taskId: string,
    data: Prisma.WorkItemUpdateInput | Prisma.WorkItemUncheckedUpdateInput,
  ): Promise<WorkItemWithRelations>;
  softDeleteTask(taskId: string): Promise<WorkItem>;
  restoreTask(taskId: string): Promise<WorkItem>;
  deleteTask(taskId: string): Promise<WorkItem>;
  findTasksByIds(taskIds: string[]): Promise<WorkItem[]>;
  bulkUpdateTasks(
    projectId: string,
    taskIds: string[],
    data: Prisma.WorkItemUpdateManyMutationInput & {
      assigneeId?: string | null;
      cycleId?: string | null;
    },
  ): Promise<{ count: number }>;
  updateTasksRank(
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
  updateAttachments(
    taskId: string,
    attachments: WorkItemAttachments,
  ): Promise<WorkItem>;
  countProjectTasks(projectId: string): Promise<number>;
  disconnectParentTask(taskId: string): Promise<WorkItemWithRelations>;
}
