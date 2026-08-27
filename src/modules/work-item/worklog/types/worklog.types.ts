/**
 * Worklog Domain Types & Interfaces
 *
 * Hexagonal / DDD-Lite ports and domain model definitions for Worklogs.
 */

import { Worklog, Prisma } from '@prisma/client';

export interface WorklogQueryOptions {
  userId?: string;
  startDate?: Date;
  endDate?: Date;
  limit: number;
  offset: number;
}

export interface WorklogPaginationResult<T> {
  items: T[];
  total: number;
  totalHours: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface IWorklogRepository {
  findProjectWorklogs(
    projectId: string,
    options: WorklogQueryOptions,
  ): Promise<{ items: any[]; total: number }>;
  findWorkspaceWorklogs(
    workspaceId: string,
    options: WorklogQueryOptions,
  ): Promise<{ items: any[]; total: number }>;
  findTaskWorklogs(taskId: string): Promise<Worklog[]>;
  createWorklog(
    data: Prisma.WorklogCreateInput | Prisma.WorklogUncheckedCreateInput,
  ): Promise<Worklog>;
  deleteWorklog(worklogId: string): Promise<Worklog>;
  updateWorklog(id: string, data: Prisma.WorklogUpdateInput): Promise<Worklog>;
  resolveWorkspaceId(projectId: string): Promise<string | null>;
}
