import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class CreateWorkItemDto {
  @ApiProperty({ description: 'Title of the work item', example: 'Design database schema' })
  @IsString()
  @IsNotEmpty({ message: 'Task title is required' })
  title!: string;

  @ApiPropertyOptional({ description: 'Detailed markdown content/notes of the work item' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: 'Short summary description of the work item' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Column ID on the project Kanban board', example: 'col-todo' })
  @IsString()
  @IsNotEmpty({ message: 'Column ID is required' })
  columnId!: string;

  @ApiPropertyOptional({ description: 'Assignee identifier or name' })
  @IsString()
  @IsOptional()
  assignee?: string;

  @ApiPropertyOptional({ description: 'User ID of the primary assignee' })
  @IsString()
  @IsOptional()
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Additional co-assignee user IDs', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  assigneeIds?: string[];

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)', example: '2026-09-01T00:00:00Z' })
  @IsOptional()
  startDate?: string | Date;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)', example: '2026-09-15T00:00:00Z' })
  @IsOptional()
  dueDate?: string | Date;

  @ApiPropertyOptional({ enum: TaskPriority, default: TaskPriority.none })
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'Ordering rank in column', example: 0 })
  @IsNumber()
  @IsOptional()
  rank?: number;

  @ApiPropertyOptional({ description: 'Cycle / Sprint identifier' })
  @IsString()
  @IsOptional()
  cycle?: string;

  @ApiPropertyOptional({ description: 'Cycle / Sprint UUID' })
  @IsString()
  @IsOptional()
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Parent work item ID for hierarchical decomposition' })
  @IsString()
  @IsOptional()
  parentTaskId?: string;

  @ApiPropertyOptional({ description: 'Labels associated with the work item', type: [String] })
  @IsArray()
  @IsOptional()
  labels?: string[];

  @ApiPropertyOptional({ description: 'Array of label IDs', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  labelIds?: string[];

  @ApiPropertyOptional({ description: 'Time spent in hours', example: 1.5 })
  @IsNumber()
  @IsOptional()
  timeSpent?: number;

  @ApiPropertyOptional({ description: 'Completion status flag', default: false })
  @IsBoolean()
  @IsOptional()
  completed?: boolean;

  @ApiPropertyOptional({ description: 'Attachments / Links JSON array' })
  @IsOptional()
  attachments?: any;

  @ApiPropertyOptional({ description: 'Relations JSON array' })
  @IsOptional()
  relations?: any;
}
