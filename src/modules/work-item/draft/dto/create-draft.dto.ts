import {
  IsEnum,
  IsOptional,
  IsString,
  IsArray,
  IsNumber,
  IsObject,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class CreateDraftDto {
  @ApiPropertyOptional({ description: 'Target project ID if selected', example: 'd3b07384-0000-0000-0000-000000000000' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Title of draft', example: 'Draft issue title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Draft description / content' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Draft detailed content' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: 'Column/state ID' })
  @IsOptional()
  @IsString()
  columnId?: string;

  @ApiPropertyOptional({ enum: TaskPriority, default: TaskPriority.none })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'Start date' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Due date' })
  @IsOptional()
  @IsString()
  dueDate?: string;

  @ApiPropertyOptional({ description: 'Label names or IDs' })
  @IsOptional()
  @IsArray()
  labels?: string[];

  @ApiPropertyOptional({ description: 'Primary assignee ID' })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Co-assignee IDs' })
  @IsOptional()
  @IsArray()
  assigneeIds?: string[];

  @ApiPropertyOptional({ description: 'Custom metadata object' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
