import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  ArrayMinSize,
  IsUUID,
} from 'class-validator';

export class AssignTaskDto {
  @ApiPropertyOptional({
    description: 'User ID of the eligible project member, or null to unassign',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    description: 'Backwards-compatible alias for assigneeId',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsOptional()
  @IsString()
  assignee?: string | null;
}

export class BulkAssignTaskDto {
  @ApiProperty({
    description: 'List of task IDs to reassign',
    example: ['d3b07384-d113-4678-831e-4eeea6608930'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least one task ID must be provided' })
  taskIds!: string[];

  @ApiPropertyOptional({
    description: 'Target assignee user ID (or null to unassign in bulk)',
    example: 'd3b07384-d113-4678-831e-4eeea6608930',
  })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    description: 'Backwards-compatible alias for assigneeId',
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
