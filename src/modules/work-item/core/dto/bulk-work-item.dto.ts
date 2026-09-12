import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority } from '@prisma/client';

export class BulkUpdateWorkItemDto {
  @ApiProperty({ description: 'Array of work item IDs to update', example: ['id-1', 'id-2'] })
  @IsArray()
  @IsNotEmpty()
  taskIds!: string[];

  @ApiProperty({
    description: 'Bulk update payload data',
    example: { columnId: 'done', priority: 'high', cycleId: 'cycle-1' },
  })
  @IsObject()
  data!: {
    columnId?: string;
    assigneeId?: string | null;
    priority?: TaskPriority | string;
    cycleId?: string | null;
    dueDate?: string | null;
    [key: string]: any;
  };

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;
}

export class BulkDeleteWorkItemDto {
  @ApiProperty({ description: 'Array of work item IDs to delete', example: ['id-1', 'id-2'] })
  @IsArray()
  @IsNotEmpty()
  taskIds!: string[];

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;
}

export class ReorderWorkItemDto {
  @ApiPropertyOptional({ description: 'Target column ID' })
  @IsString()
  @IsOptional()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Target rank position in column', example: 1 })
  @IsNumber()
  @IsOptional()
  rank?: number;
}

export class DuplicateWorkItemDto {
  @ApiPropertyOptional({ description: 'Destination project ID' })
  @IsString()
  @IsOptional()
  destinationProjectId?: string;
}

export class AssignWorkItemDto {
  @ApiPropertyOptional({ description: 'Assignee user ID or null to unassign' })
  @IsString()
  @IsOptional()
  assigneeId?: string | null;
}
