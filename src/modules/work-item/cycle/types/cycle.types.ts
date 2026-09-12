/**
 * Cycle Domain Types & Interfaces
 *
 * Hexagonal / DDD-Lite ports and domain model definitions for Sprint Cycles.
 */

import { Cycle, CyclePhase, CycleStatus, Prisma, Task } from '@prisma/client';

export enum IncompleteTaskAction {
  transfer = 'transfer',
  backlog = 'backlog',
  leave = 'leave',
}

export interface CycleStats {
  totalTasks: number;
  completedTasks: number;
  startedTasks: number;
  unstartedTasks: number;
  backlogTasks: number;
  cancelledTasks: number;
  completionPercentage: number;
}

export interface CyclePhaseInfo {
  label: string;
  order: number;
}

export const CYCLE_PHASE_CONFIG: Record<CyclePhase, CyclePhaseInfo> = {
  [CyclePhase.topic_selection]: { label: 'Topic Selection', order: 1 },
  [CyclePhase.literature_review]: { label: 'Literature Review', order: 2 },
  [CyclePhase.methodology]: { label: 'Methodology & Design', order: 3 },
  [CyclePhase.data_collection]: { label: 'Data Collection', order: 4 },
  [CyclePhase.data_analysis]: {
    label: 'Data Analysis & Experiments',
    order: 5,
  },
  [CyclePhase.writing]: { label: 'Manuscript Writing', order: 6 },
  [CyclePhase.review_revision]: { label: 'Peer Review & Revision', order: 7 },
  [CyclePhase.submission]: { label: 'Camera-Ready Submission', order: 8 },
  [CyclePhase.custom]: { label: 'Custom Milestone', order: 9 },
};

export interface CycleTaskItem {
  id: string;
  title: string;
  columnId: string;
  priority?: string;
  completed: boolean;
}

export interface ICycleRepository {
  findProjectCycles(projectId: string): Promise<Cycle[]>;
  findActiveCycle(projectId: string, excludeId?: string): Promise<Cycle | null>;
  findCycleById(cycleId: string): Promise<Cycle | null>;
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
  findCycleTasks(cycleId: string): Promise<CycleTaskItem[]>;
  transferIncompleteTasks(
    fromCycleId: string,
    targetCycleId: string | null,
    incompleteTaskIds?: string[],
  ): Promise<Prisma.BatchPayload>;
  addTaskToCycle(taskId: string, cycleId: string): Promise<Task>;
  removeTaskFromCycle(taskId: string): Promise<Task>;
  addTasksBatch(
    taskIds: string[],
    cycleId: string,
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
