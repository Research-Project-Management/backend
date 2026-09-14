import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  ArrayMinSize,
  IsUUID,
} from 'class-validator';

export class AssignWorkItemDto {
  @ApiPropertyOptional({
    description: 'User ID of the eligible project member, or null to unassign',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    description: 'Alias for assigneeId',
  })
  @IsOptional()
  @IsString()
  assignee?: string | null;
}

export class BulkAssignWorkItemDto {
  @ApiPropertyOptional({
    description: 'List of WorkItem IDs to reassign',
    example: ['d3b07384-d113-4678-831e-4eeea6608930'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  workItemIds?: string[];

  @ApiPropertyOptional({
    description: 'Target assignee user ID (or null to unassign in bulk)',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    description: 'Alias for assigneeId',
  })
  @IsOptional()
  @IsString()
  assignee?: string | null;
}

/**
 * Set the complete list of assignees on a work item (replaces existing list).
 * First entry becomes the primary assignee (assigneeId).
 */
export class SetAssigneesDto {
  @ApiProperty({
    description:
      'Ordered list of assignee user IDs. First entry becomes the primary assignee. ' +
      'Pass an empty array [] to remove all assignees.',
    example: ['user-id-1', 'user-id-2'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  assigneeIds!: string[];
}

/**
 * Add a single co-assignee to an existing work item.
 */
export class AddAssigneeDto {
  @ApiProperty({
    description: 'User ID of the co-assignee to add',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsString()
  @IsUUID()
  assigneeId!: string;
}
