import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectPriority, ProjectState } from '@prisma/client';

export class WorkItemStateCountDto {
  @ApiProperty({ example: 'started' })
  group!: string;

  @ApiProperty({ example: 12 })
  count!: number;
}

export class WorkItemPriorityCountDto {
  @ApiProperty({ enum: ProjectPriority, example: ProjectPriority.urgent })
  priority!: string;

  @ApiProperty({ example: 4 })
  count!: number;
}

export class ProjectPortfolioOverviewDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  projectId!: string;

  @ApiProperty({ example: 'Deep Learning Genome Analysis' })
  name!: string;

  @ApiProperty({ enum: ProjectState, example: ProjectState.execution })
  state!: ProjectState;

  @ApiProperty({ enum: ProjectPriority, example: ProjectPriority.high })
  priority!: ProjectPriority;

  @ApiPropertyOptional({ example: '2026-10-01' })
  startDate?: Date | null;

  @ApiPropertyOptional({ example: '2026-12-31' })
  targetDate?: Date | null;

  @ApiPropertyOptional({ example: 106, description: 'Days remaining until target date (negative if overdue)' })
  daysRemaining?: number | null;

  @ApiPropertyOptional({ example: false })
  isOverdue?: boolean;

  @ApiProperty({ example: 45 })
  totalWorkItems!: number;

  @ApiProperty({ example: 25 })
  completedWorkItems!: number;

  @ApiProperty({ example: 15 })
  inProgressWorkItems!: number;

  @ApiProperty({ example: 5 })
  backlogWorkItems!: number;

  @ApiProperty({ example: 55.56, description: 'Percentage of completed work items' })
  completionPercentage!: number;

  @ApiProperty({ example: 6 })
  totalMembers!: number;

  @ApiProperty({ example: 3 })
  totalCycles!: number;

  @ApiPropertyOptional({
    example: { id: 'uuid', name: 'Sprint 1', progressPercentage: 70 },
  })
  activeCycle?: {
    id: string;
    name: string;
    progressPercentage: number;
  } | null;
}
