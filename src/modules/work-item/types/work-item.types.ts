/**
 * WorkItem Domain Types & Interfaces
 *
 * Hexagonal / DDD-Lite ports and domain model definitions.
 */

import {
  Task,
  TaskPriority,
  TaskRecurrence,
  TaskReminder,
  Prisma,
} from '@prisma/client';

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

export type WorkItemWithRelations = Prisma.TaskGetPayload<{
  include: {
    assignee: { select: typeof USER_MINIMAL_SELECT };
    cycle: { select: typeof CYCLE_SELECT };
    parentTask: { select: { id: true; title: true; identifier: true } };
    subtasks: {
      select: typeof SUBTASK_SELECT;
    };
    project: { select: { id: true; workspaceId: true } };
  };
}>;

export type TaskWithRelations = WorkItemWithRelations;

export interface WorkItemResponse {
  id: string;
  _id: string;
  identifier?: string | null;
  sequenceNumber?: number | null;
  title: string;
  content: string;
  description: string;
  columnId: string;
  priority: TaskPriority;
  startDate?: string | null;
  dueDate?: string | null;
  labels: string[];
  checklists: any;
  completed: boolean;
  rank: number;
  timeSpent?: number | null;
  projectId: string;
  authorId: string;
  assigneeId?: any;
  cycleId?: string | null;
  parentTaskId?: string | null;
  parentTask?: any;
  subtasks?: any[];
  subtaskCount?: number;
  subtaskCompletedCount?: number;
  assignee?: any;
  cycle?: any;
  createdAt: string;
  updatedAt: string;
}

export type TaskResponse = WorkItemResponse;

export interface WorkItemFilterOptions {
  cycleId?: string;
  columnId?: string;
  priority?: TaskPriority;
  assigneeId?: string;
  parentTaskId?: string;
  completed?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface IWorkItemRepository {
  findWorkspaceTasks(workspaceId: string): Promise<any[]>;
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
    data: Prisma.TaskCreateInput | Prisma.TaskUncheckedCreateInput,
  ): Promise<WorkItemWithRelations>;
  updateTask(
    taskId: string,
    data: Prisma.TaskUpdateInput | Prisma.TaskUncheckedUpdateInput,
  ): Promise<WorkItemWithRelations>;
  softDeleteTask(taskId: string): Promise<Task>;
  restoreTask(taskId: string): Promise<Task>;
  deleteTask(taskId: string): Promise<Task>;
  assignTask(
    taskId: string,
    assigneeId: string | null,
  ): Promise<WorkItemWithRelations>;
  updateTasksRank(
    updates: Array<{
      id: string;
      rank: number;
      columnId?: string;
      completed?: boolean;
    }>,
  ): Promise<Task[]>;
}

export type ITaskRepository = IWorkItemRepository;
