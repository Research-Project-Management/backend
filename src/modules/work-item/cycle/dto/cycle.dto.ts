import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CycleStatus, CyclePhase } from '@prisma/client';
import {
  IncompleteTaskAction,
  CyclePhaseInfo,
  CYCLE_PHASE_CONFIG,
} from '../types/cycle.types';

export { IncompleteTaskAction, CyclePhaseInfo, CYCLE_PHASE_CONFIG };

export class CreateCycleDto {
  @ApiProperty({
    description: 'Cycle / Sprint title',
    example: 'Sprint 1 - Foundations',
  })
  @IsString()
  @IsNotEmpty({ message: 'Cycle name is required' })
  name!: string;

  @ApiPropertyOptional({ description: 'Cycle objective or description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Start date (ISO string)',
    example: '2026-09-01T00:00:00Z',
  })
  @IsOptional()
  startDate?: string | Date;

  @ApiPropertyOptional({
    description: 'End date (ISO string)',
    example: '2026-09-14T23:59:59Z',
  })
  @IsOptional()
  endDate?: string | Date;

  @ApiPropertyOptional({ enum: CycleStatus, default: CycleStatus.planned })
  @IsEnum(CycleStatus)
  @IsOptional()
  status?: CycleStatus;

  @ApiPropertyOptional({ enum: CyclePhase, default: CyclePhase.custom })
  @IsEnum(CyclePhase)
  @IsOptional()
  phase?: CyclePhase;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class UpdateCycleDto {
  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsString()
  @IsOptional()
  workspaceId?: string;

  @ApiPropertyOptional({ description: 'Updated cycle name' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Updated cycle description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Updated start date' })
  @IsOptional()
  startDate?: string | Date;

  @ApiPropertyOptional({ description: 'Updated end date' })
  @IsOptional()
  endDate?: string | Date;

  @ApiPropertyOptional({ enum: CycleStatus })
  @IsEnum(CycleStatus)
  @IsOptional()
  status?: CycleStatus;

  @ApiPropertyOptional({ enum: CyclePhase })
  @IsEnum(CyclePhase)
  @IsOptional()
  phase?: CyclePhase;
}

export class AddCycleTaskDto {
  @ApiProperty({
    description: 'Task / Work item ID to add to cycle',
    example: 'task-123',
  })
  @IsString()
  @IsNotEmpty({ message: 'Task ID is required' })
  taskId!: string;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class CompleteCycleDto {
  @ApiProperty({
    enum: IncompleteTaskAction,
    description: 'Action to handle remaining incomplete tasks',
    example: IncompleteTaskAction.transfer,
  })
  @IsEnum(IncompleteTaskAction)
  @IsNotEmpty({ message: 'Incomplete task action is required' })
  action!: IncompleteTaskAction;

  @ApiPropertyOptional({
    description: 'Target cycle ID when action is transfer',
    example: 'cycle-next-123',
  })
  @IsString()
  @IsOptional()
  targetCycleId?: string;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsString()
  @IsOptional()
  workspaceId?: string;
}
