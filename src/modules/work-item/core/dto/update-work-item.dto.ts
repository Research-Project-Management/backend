import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class UpdateWorkItemDto {
  @ApiPropertyOptional({ description: 'Title of the work item' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Detailed markdown content/notes' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: 'Short summary description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Column ID on the project Kanban board' })
  @IsString()
  @IsOptional()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Assignee identifier' })
  @IsString()
  @IsOptional()
  assignee?: string;

  @ApiPropertyOptional({ description: 'User ID of the primary assignee (or null to unassign)' })
  @IsString()
  @IsOptional()
  assigneeId?: string | null;

  @ApiPropertyOptional({ description: 'Additional co-assignee user IDs', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  assigneeIds?: string[];

  @ApiPropertyOptional({ description: 'Start date (ISO 8601)' })
  @IsOptional()
  startDate?: string | Date | null;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601)' })
  @IsOptional()
  dueDate?: string | Date | null;

  @ApiPropertyOptional({ enum: TaskPriority })
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'Ordering rank in column' })
  @IsNumber()
  @IsOptional()
  rank?: number;

  @ApiPropertyOptional({ description: 'Cycle / Sprint UUID' })
  @IsString()
  @IsOptional()
  cycleId?: string | null;

  @ApiPropertyOptional({ description: 'Parent work item ID for hierarchical decomposition' })
  @IsString()
  @IsOptional()
  parentTaskId?: string | null;

  @ApiPropertyOptional({ description: 'Labels associated with the work item', type: [String] })
  @IsArray()
  @IsOptional()
  labels?: string[];

  @ApiPropertyOptional({ description: 'Array of label IDs', type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  labelIds?: string[];

  @ApiPropertyOptional({ description: 'Time spent in hours' })
  @IsNumber()
  @IsOptional()
  timeSpent?: number;

  @ApiPropertyOptional({ description: 'Completion status flag' })
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
