import {
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkItemPriority } from '@prisma/client';

export interface BulkUpdatePayload {
  columnId?: string;
  assigneeId?: string | null;
  priority?: WorkItemPriority | (string & {});
  dueDate?: string | null;
  startDate?: string | null;
  addLabel?: string;
  removeLabel?: string;
  [key: string]: unknown;
}

export class BulkUpdateWorkItemDto {
  @ApiPropertyOptional({
    description: 'Array of work item IDs to update',
    example: ['id-1', 'id-2'],
  })
  @IsArray()
  @IsOptional()
  workItemIds?: string[];

  @ApiPropertyOptional({
    description: 'Array of work item IDs to update (alias for workItemIds)',
  })
  @IsArray()
  @IsOptional()
  ids?: string[];

  @ApiProperty({
    description: 'Bulk update payload data',
    example: { columnId: 'done', priority: 'high' },
  })
  @IsObject()
  data!: BulkUpdatePayload;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;
}

export class BulkDeleteWorkItemDto {
  @ApiPropertyOptional({
    description: 'Array of work item IDs to delete',
    example: ['id-1', 'id-2'],
  })
  @IsArray()
  @IsOptional()
  workItemIds?: string[];

  @ApiPropertyOptional({
    description: 'Array of work item IDs to delete (alias for workItemIds)',
  })
  @IsArray()
  @IsOptional()
  ids?: string[];

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;
}

export class ReorderWorkItemDto {
  @ApiPropertyOptional({ description: 'Work item ID to reorder' })
  @IsString()
  @IsOptional()
  workItemId?: string;

  @ApiPropertyOptional({
    description: 'Work item ID to reorder (alias for workItemId)',
  })
  @IsString()
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({ description: 'Target column ID' })
  @IsString()
  @IsOptional()
  columnId?: string;

  @ApiPropertyOptional({
    description: 'Target rank position in column',
    example: 1,
  })
  @IsNumber()
  @IsOptional()
  rank?: number;
}

export class DuplicateWorkItemDto {
  @ApiPropertyOptional({ description: 'Destination project ID' })
  @IsString()
  @IsOptional()
  destinationProjectId?: string;

  @ApiPropertyOptional({ description: 'Alias for destination project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;
}
