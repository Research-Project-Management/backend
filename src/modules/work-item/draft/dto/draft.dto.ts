import {
  IsEnum,
  IsOptional,
  IsString,
  IsArray,
  IsObject,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { WorkItemPriority } from '@prisma/client';

export class CreateDraftDto {
  @ApiPropertyOptional({
    description: 'Target project ID if selected',
    example: 'd3b07384-0000-0000-0000-000000000000',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Title of draft',
    example: 'Draft issue title',
  })
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

  @ApiPropertyOptional({
    enum: WorkItemPriority,
    default: WorkItemPriority.none,
  })
  @IsOptional()
  @IsEnum(WorkItemPriority)
  priority?: WorkItemPriority;

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
  metadata?: Record<string, unknown>;
}

export class UpdateDraftDto extends PartialType(CreateDraftDto) {}

export class PublishDraftDto {
  @ApiPropertyOptional({
    description: 'Target project ID if not previously set on draft',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Override column/state ID upon publishing',
  })
  @IsOptional()
  @IsString()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Override title upon publishing' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ enum: WorkItemPriority })
  @IsOptional()
  @IsEnum(WorkItemPriority)
  priority?: WorkItemPriority;
}

export class QueryDraftDto {
  @ApiPropertyOptional({ description: 'Filter drafts by project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Search term in draft title' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}
