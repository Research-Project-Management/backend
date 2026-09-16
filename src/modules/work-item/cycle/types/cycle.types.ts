/**
 * Cycle Domain Types & Interfaces
 *
 * Hexagonal / DDD-Lite ports and domain model definitions for Sprint Cycles.
 */

import { Cycle, CycleStatus, Prisma, WorkItem } from '@prisma/client';

export enum IncompleteWorkItemAction {
  transfer = 'transfer',
  backlog = 'backlog',
  leave = 'leave',
}

export interface CycleStats {
  totalWorkItems: number;
  completedWorkItems: number;
  startedWorkItems: number;
  unstartedWorkItems: number;
  backlogWorkItems: number;
  cancelledWorkItems: number;
  completionPercentage: number;
}

export interface CycleWorkItemItem {
  id: string;
  title: string;
  columnId: string;
  priority?: string;
  completed: boolean;
  state?: { id?: string; name?: string; group?: string } | null;
}

export type CycleWithWorkItems = Cycle & {
  workItems: (WorkItem & { assignee?: any })[];
};

export interface ICycleRepository {
  findProjectCycles(projectId: string): Promise<Cycle[]>;
  findActiveCycle(projectId: string, excludeId?: string): Promise<Cycle | null>;
  findCycleById(cycleId: string): Promise<CycleWithWorkItems | null>;
  findOverlappingCycle(
    projectId: string,
    start: Date,
    end: Date,
    excludeId?: string,
  ): Promise<Cycle | null>;
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
  findCycleWorkItems(cycleId: string): Promise<CycleWorkItemItem[]>;
  transferIncompleteWorkItems(
    fromCycleId: string,
    targetCycleId: string | null,
    incompleteWorkItemIds?: string[],
  ): Promise<Prisma.BatchPayload>;
  findWorkItemById(
    workItemId: string,
  ): Promise<{ id: string; projectId: string } | null>;
  addWorkItemToCycle(workItemId: string, cycleId: string): Promise<WorkItem>;
  removeWorkItemFromCycle(workItemId: string): Promise<WorkItem>;
  addWorkItemsBatch(
    workItemIds: string[],
    cycleId: string,
    projectId?: string,
  ): Promise<Prisma.BatchPayload>;
  findCyclesEligibleForAutoStart(
    now?: Date,
    projectId?: string,
  ): Promise<Cycle[]>;
  findCyclesEligibleForAutoComplete(
    now?: Date,
    projectId?: string,
  ): Promise<Cycle[]>;
  hasActiveCycle(projectId: string): Promise<boolean>;
}
