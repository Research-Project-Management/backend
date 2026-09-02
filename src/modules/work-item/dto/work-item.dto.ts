import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskPriority, Prisma } from '@prisma/client';

export class CreateWorkItemDto {
  @ApiProperty({
    description: 'Title of the work item',
    example: 'Design database schema',
  })
  @IsString()
  @IsNotEmpty({ message: 'Task title is required' })
  title!: string;

  @ApiPropertyOptional({
    description: 'Detailed markdown content/notes of the work item',
  })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({
    description: 'Short summary description of the work item',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Column ID on the project Kanban board',
    example: 'col-todo',
  })
  @IsString()
  @IsNotEmpty({ message: 'Column ID is required' })
  columnId!: string;

  @ApiPropertyOptional({ description: 'Assignee identifier or name' })
  @IsString()
  @IsOptional()
  assignee?: string;

  @ApiPropertyOptional({ description: 'User ID of the assignee' })
  @IsString()
  @IsOptional()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Start date (ISO 8601)',
    example: '2026-09-01T00:00:00Z',
  })
  @IsOptional()
  startDate?: string | Date;

  @ApiPropertyOptional({
    description: 'Due date (ISO 8601)',
    example: '2026-09-15T00:00:00Z',
  })
  @IsOptional()
  dueDate?: string | Date;

  @ApiPropertyOptional({ enum: TaskPriority, default: TaskPriority.none })
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @ApiPropertyOptional({
    description: 'Estimated effort in hours or story points',
    example: 4.5,
  })
  @IsNumber()
  @IsOptional()
  estimate?: number;

  @ApiPropertyOptional({ description: 'Ordering rank in column', example: 0 })
  @IsNumber()
  @IsOptional()
  rank?: number;

  @ApiPropertyOptional({ description: 'Cycle / Sprint identifier' })
  @IsString()
  @IsOptional()
  cycle?: string;

  @ApiPropertyOptional({ description: 'Sprint cycle ID' })
  @IsString()
  @IsOptional()
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Parent work item reference' })
  @IsString()
  @IsOptional()
  parentTask?: string;

  @ApiPropertyOptional({
    description: 'Parent work item ID for hierarchical subtasks',
  })
  @IsString()
  @IsOptional()
  parentTaskId?: string;

  @ApiPropertyOptional({
    description: 'Labels/tags',
    example: ['backend', 'database'],
  })
  @IsArray()
  @IsOptional()
  labels?: string[];

  @ApiPropertyOptional({
    description: 'Checklist items',
    example: [{ id: 'chk-1', title: 'Write SQL migration', completed: false }],
  })
  @IsArray()
  @IsOptional()
  checklists?: Prisma.InputJsonValue;

  @ApiPropertyOptional({ description: 'Attachments metadata list' })
  @IsArray()
  @IsOptional()
  attachments?: Prisma.InputJsonValue;

  @ApiPropertyOptional({ description: 'Recurrence rule', example: 'none' })
  @IsString()
  @IsOptional()
  recurrence?: string;

  @ApiPropertyOptional({ description: 'Reminder timing', example: '1h' })
  @IsString()
  @IsOptional()
  reminder?: string;

  @ApiPropertyOptional({ description: 'Project ID', example: 'proj-123' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID', example: 'ws-123' })
  @IsString()
  @IsOptional()
  workspaceId?: string;

  @ApiPropertyOptional({ description: 'Time spent in hours', example: 2.0 })
  @IsNumber()
  @IsOptional()
  timeSpent?: number;

  @ApiPropertyOptional({ description: 'Work item issue type', example: 'task' })
  @IsString()
  @IsOptional()
  issueType?: string;

  @ApiPropertyOptional({ description: 'Story points estimate', example: 3 })
  @IsNumber()
  @IsOptional()
  storyPoints?: number;

  @ApiPropertyOptional({ description: 'Work item relations', example: [] })
  @IsArray()
  @IsOptional()
  relations?: Prisma.InputJsonValue;

  @ApiPropertyOptional({ description: 'Completed status override' })
  @IsBoolean()
  @IsOptional()
  completed?: boolean;
}

export class UpdateWorkItemDto {
  @ApiPropertyOptional({ description: 'Project ID', example: 'proj-123' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID', example: 'ws-123' })
  @IsString()
  @IsOptional()
  workspaceId?: string;

  @ApiPropertyOptional({ description: 'Updated title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Updated markdown content' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({ description: 'Updated description' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Updated column ID' })
  @IsString()
  @IsOptional()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Updated assignee name or null' })
  @IsString()
  @IsOptional()
  assignee?: string | null;

  @ApiPropertyOptional({ description: 'Updated assignee user ID or null' })
  @IsString()
  @IsOptional()
  assigneeId?: string | null;

  @ApiPropertyOptional({ description: 'Updated start date' })
  @IsOptional()
  startDate?: string | Date;

  @ApiPropertyOptional({ description: 'Updated due date' })
  @IsOptional()
  dueDate?: string | Date;

  @ApiPropertyOptional({ enum: TaskPriority })
  @IsEnum(TaskPriority)
  @IsOptional()
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'Updated estimate' })
  @IsNumber()
  @IsOptional()
  estimate?: number;

  @ApiPropertyOptional({ description: 'Updated cycle' })
  @IsString()
  @IsOptional()
  cycle?: string | null;

  @ApiPropertyOptional({ description: 'Updated cycle ID or null' })
  @IsString()
  @IsOptional()
  cycleId?: string | null;

  @ApiPropertyOptional({ description: 'Updated parent task' })
  @IsString()
  @IsOptional()
  parentTask?: string | null;

  @ApiPropertyOptional({ description: 'Updated parent task ID' })
  @IsString()
  @IsOptional()
  parentTaskId?: string | null;

  @ApiPropertyOptional({ description: 'Updated labels' })
  @IsArray()
  @IsOptional()
  labels?: string[];

  @ApiPropertyOptional({ description: 'Updated checklists' })
  @IsArray()
  @IsOptional()
  checklists?: Prisma.InputJsonValue;

  @ApiPropertyOptional({ description: 'Updated attachments' })
  @IsArray()
  @IsOptional()
  attachments?: Prisma.InputJsonValue;

  @ApiPropertyOptional({ description: 'Updated rank in column' })
  @IsNumber()
  @IsOptional()
  rank?: number;

  @ApiPropertyOptional({ description: 'Updated recurrence pattern' })
  @IsString()
  @IsOptional()
  recurrence?: string;

  @ApiPropertyOptional({ description: 'Updated reminder settings' })
  @IsString()
  @IsOptional()
  reminder?: string;

  @ApiPropertyOptional({ description: 'Updated time spent in hours' })
  @IsNumber()
  @IsOptional()
  timeSpent?: number;

  @ApiPropertyOptional({ description: 'Completion status override' })
  @IsBoolean()
  @IsOptional()
  completed?: boolean;

  @ApiPropertyOptional({ description: 'Updated issue type' })
  @IsString()
  @IsOptional()
  issueType?: string;

  @ApiPropertyOptional({ description: 'Updated story points' })
  @IsNumber()
  @IsOptional()
  storyPoints?: number;

  @ApiPropertyOptional({ description: 'Updated relations' })
  @IsArray()
  @IsOptional()
  relations?: Prisma.InputJsonValue;
}

export class AssignWorkItemDto {
  @ApiProperty({ description: 'User ID of the assignee', example: 'usr-123' })
  @IsString()
  @IsNotEmpty({ message: 'Assignee ID is required' })
  assignee!: string;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;
}

export class ReorderWorkItemDto {
  @ApiPropertyOptional({ description: 'Source column rank index' })
  @IsNumber()
  @IsOptional()
  sourceIndex?: number;

  @ApiPropertyOptional({ description: 'Destination column rank index' })
  @IsNumber()
  @IsOptional()
  destinationIndex?: number;

  @ApiPropertyOptional({ description: 'Source column ID' })
  @IsString()
  @IsOptional()
  sourceColumnId?: string;

  @ApiPropertyOptional({ description: 'Destination column ID' })
  @IsString()
  @IsOptional()
  destinationColumnId?: string;

  @ApiPropertyOptional({ description: 'Target work item ID' })
  @IsString()
  @IsOptional()
  taskId?: string;

  @ApiPropertyOptional({ description: 'Target column ID' })
  @IsString()
  @IsOptional()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Target absolute rank number' })
  @IsNumber()
  @IsOptional()
  rank?: number;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class BulkUpdateWorkItemDto {
  @ApiProperty({
    description: 'Array of work item IDs to update',
    example: ['task-1', 'task-2'],
  })
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
    priority?: TaskPriority | (string & {});
    cycleId?: string | null;
    [key: string]: any;
  };

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsString()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class QueryWorkItemDto {
  @ApiPropertyOptional({ description: 'Filter by cycle/sprint ID' })
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Alias for cycleId' })
  @IsOptional()
  @IsString()
  cycle?: string;

  @ApiPropertyOptional({ description: 'Filter by board column ID' })
  @IsOptional()
  @IsString()
  columnId?: string;

  @ApiPropertyOptional({
    enum: TaskPriority,
    description: 'Filter by priority',
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'Filter by assignee user ID' })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Filter by parent task ID' })
  @IsOptional()
  @IsString()
  parentTaskId?: string;

  @ApiPropertyOptional({ description: 'Filter by completion state' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  completed?: boolean;

  @ApiPropertyOptional({ description: 'Search term for title or identifier' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Filter by workspace ID' })
  @IsOptional()
  @IsString()
  workspaceId?: string;

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Page size for pagination', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// Aliases for compatibility
export const CreateTaskDto = CreateWorkItemDto;
export type CreateTaskDto = CreateWorkItemDto;

export const UpdateTaskDto = UpdateWorkItemDto;
export type UpdateTaskDto = UpdateWorkItemDto;

export const AssignTaskDto = AssignWorkItemDto;
export type AssignTaskDto = AssignWorkItemDto;

export const ReorderTaskDto = ReorderWorkItemDto;
export type ReorderTaskDto = ReorderWorkItemDto;

export const BulkUpdateTaskDto = BulkUpdateWorkItemDto;
export type BulkUpdateTaskDto = BulkUpdateWorkItemDto;

export const QueryTaskDto = QueryWorkItemDto;
export type QueryTaskDto = QueryWorkItemDto;
