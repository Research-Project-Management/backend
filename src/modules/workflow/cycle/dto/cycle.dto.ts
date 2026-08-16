import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CycleStatus, CyclePhase } from '@prisma/client';

export enum IncompleteTaskAction {
  transfer = 'transfer',
  backlog = 'backlog',
  leave = 'leave',
}

export class CreateCycleDto {
  @IsString()
  @IsNotEmpty({ message: 'Cycle name is required' })
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsOptional()
  startDate?: string | Date;

  @IsOptional()
  endDate?: string | Date;

  @IsEnum(CycleStatus)
  @IsOptional()
  status?: CycleStatus;

  @IsEnum(CyclePhase)
  @IsOptional()
  phase?: CyclePhase;
}

export class UpdateCycleDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsOptional()
  startDate?: string | Date;

  @IsOptional()
  endDate?: string | Date;

  @IsEnum(CycleStatus)
  @IsOptional()
  status?: CycleStatus;

  @IsEnum(CyclePhase)
  @IsOptional()
  phase?: CyclePhase;
}

export class AddCycleTaskDto {
  @IsString()
  @IsNotEmpty({ message: 'Task ID is required' })
  taskId!: string;
}

export class CompleteCycleDto {
  @IsEnum(IncompleteTaskAction)
  @IsNotEmpty({ message: 'Incomplete task action is required' })
  action!: IncompleteTaskAction;

  @IsString()
  @IsOptional()
  targetCycleId?: string;
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
