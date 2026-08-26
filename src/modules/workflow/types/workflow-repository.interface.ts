/**
 * Workflow Domain Repository Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { Task, Cycle, Worklog, Prisma } from '@prisma/client';

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

export type TaskWithRelations = Prisma.TaskGetPayload<{
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

export interface ITaskRepository {
  findWorkspaceTasks(workspaceId: string): Promise<any[]>;
  findProjectTasks(
    projectId: string,
    cycleId?: string,
  ): Promise<TaskWithRelations[]>;
  findTaskById(taskId: string): Promise<TaskWithRelations | null>;
  findTaskByIdentifier(
    projectId: string,
    identifier: string,
  ): Promise<TaskWithRelations | null>;
  nextProjectTaskIdentifier(
    projectId: string,
  ): Promise<{ identifier: string; sequenceNumber: number }>;
  createTask(
    data: Prisma.TaskCreateInput | Prisma.TaskUncheckedCreateInput,
  ): Promise<TaskWithRelations>;
  updateTask(
    taskId: string,
    data: Prisma.TaskUpdateInput | Prisma.TaskUncheckedUpdateInput,
  ): Promise<TaskWithRelations>;
  softDeleteTask(taskId: string): Promise<Task>;
  restoreTask(taskId: string): Promise<Task>;
  deleteTask(taskId: string): Promise<Task>;
  assignTask(
    taskId: string,
    assigneeId: string | null,
  ): Promise<TaskWithRelations>;
  updateTasksRank(
    updates: Array<{
      id: string;
      rank: number;
      columnId?: string;
      completed?: boolean;
    }>,
  ): Promise<Task[]>;
}

export interface ICycleRepository {
  findProjectCycles(projectId: string): Promise<Cycle[]>;
  findCycleById(cycleId: string): Promise<Cycle | null>;
  createCycle(
    data: Prisma.CycleCreateInput | Prisma.CycleUncheckedCreateInput,
  ): Promise<Cycle>;
  updateCycle(
    cycleId: string,
    data: Prisma.CycleUpdateInput | Prisma.CycleUncheckedUpdateInput,
  ): Promise<Cycle>;
  softDeleteCycle(cycleId: string): Promise<Cycle>;
  restoreCycle(cycleId: string): Promise<Cycle>;
  deleteCycle(cycleId: string): Promise<Cycle>;
}

export interface IWorklogRepository {
  findProjectWorklogs(
    projectId: string,
    options: {
      userId?: string;
      startDate?: Date;
      endDate?: Date;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: any[]; total: number }>;
  findTaskWorklogs(taskId: string): Promise<Worklog[]>;
  createWorklog(
    data: Prisma.WorklogCreateInput | Prisma.WorklogUncheckedCreateInput,
  ): Promise<Worklog>;
  deleteWorklog(worklogId: string): Promise<Worklog>;
}
