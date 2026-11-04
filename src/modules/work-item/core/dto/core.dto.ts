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
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkItemPriority } from '@prisma/client';
import type { WorkItemAttachments } from '@/modules/work-item/core/types/core.types';

// ── Create & Update DTOs ─────────────────────────────────────────────────────

export class CreateWorkItemDto {
  @ApiProperty({
    description: 'Title of the work item',
    example: 'Design database schema',
  })
  @IsString()
  @IsNotEmpty({ message: 'WorkItem title is required' })
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

  @ApiPropertyOptional({
    description: 'Column ID on the project Kanban board',
    example: 'col-todo',
  })
  @IsString()
  @IsOptional()
  columnId?: string;

  @ApiPropertyOptional({ description: 'Assignee identifier or name' })
  @IsString()
  @IsOptional()
  assignee?: string;

  @ApiPropertyOptional({ description: 'User ID of the primary assignee' })
  @IsString()
  @IsOptional()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Additional co-assignee user IDs',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  assigneeIds?: string[];

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

  @ApiPropertyOptional({
    enum: WorkItemPriority,
    default: WorkItemPriority.none,
  })
  @IsEnum(WorkItemPriority)
  @IsOptional()
  priority?: WorkItemPriority;

  @ApiPropertyOptional({ description: 'Ordering rank in column', example: 0 })
  @IsNumber()
  @IsOptional()
  rank?: number;

  @ApiPropertyOptional({
    description: 'Parent work item ID for hierarchical decomposition',
  })
  @IsString()
  @IsOptional()
  parentWorkItemId?: string;

  @ApiPropertyOptional({
    description: 'Parent work item ID (alias for parentWorkItemId)',
  })
  @IsString()
  @IsOptional()
  parentId?: string;

  @ApiPropertyOptional({
    description: 'Labels associated with the work item',
    type: [String],
  })
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
          .map((item) =>
            typeof item === 'string'
              ? item
              : typeof item === 'object' && item !== null
                ? String(
                    (item as Record<string, unknown>).id ||
                      (item as Record<string, unknown>).name ||
                      '',
                  )
                : '',
          )
          .filter(Boolean)
      : value,
  )
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

  @ApiPropertyOptional({
    description: 'Completion status flag',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  completed?: boolean;

  @ApiPropertyOptional({ description: 'Attachments / Links JSON array' })
  @IsOptional()
  attachments?: WorkItemAttachments | Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Relations JSON array' })
  @IsOptional()
  relations?: Record<string, unknown> | Array<Record<string, unknown>>;
}

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

  @ApiPropertyOptional({
    description: 'User ID of the primary assignee (or null to unassign)',
  })
  @IsString()
  @IsOptional()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    description: 'Additional co-assignee user IDs',
    type: [String],
  })
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

  @ApiPropertyOptional({ enum: WorkItemPriority })
  @IsEnum(WorkItemPriority)
  @IsOptional()
  priority?: WorkItemPriority;

  @ApiPropertyOptional({ description: 'Ordering rank in column' })
  @IsNumber()
  @IsOptional()
  rank?: number;

  @ApiPropertyOptional({
    description: 'Parent work item ID for hierarchical decomposition',
  })
  @IsString()
  @IsOptional()
  parentWorkItemId?: string | null;

  @ApiPropertyOptional({
    description: 'Parent work item ID (alias for parentWorkItemId)',
  })
  @IsString()
  @IsOptional()
  parentId?: string | null;

  @ApiPropertyOptional({
    description: 'Labels associated with the work item',
    type: [String],
  })
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
          .map((item) =>
            typeof item === 'string'
              ? item
              : typeof item === 'object' && item !== null
                ? String(
                    (item as Record<string, unknown>).id ||
                      (item as Record<string, unknown>).name ||
                      '',
                  )
                : '',
          )
          .filter(Boolean)
      : value,
  )
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
  attachments?: WorkItemAttachments | Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Relations JSON array' })
  @IsOptional()
  relations?: Record<string, unknown> | Array<Record<string, unknown>>;

  @ApiPropertyOptional({ description: 'Subscriber user IDs JSON array' })
  @IsOptional()
  subscriberIds?: string[];

  @ApiPropertyOptional({
    description:
      'Expected last modified timestamp for optimistic concurrency control',
  })
  @IsOptional()
  expectedUpdatedAt?: string | Date;
}

// ── Bulk, Reorder & Duplicate DTOs ───────────────────────────────────────────

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

// ── Query & Filter DTO ───────────────────────────────────────────────────────

const toArrayOrString = ({
  value,
}: {
  value: unknown;
}): string | string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : '',
      )
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    if (value.includes(',')) {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return undefined;
};

export class QueryWorkItemDto {
  @ApiPropertyOptional({ description: 'Filter by project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Filter by work item ID(s) or identifier(s)',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  workItems?: string | string[];

  @ApiPropertyOptional({ description: 'Alias for workItems' })
  @IsOptional()
  @Transform(toArrayOrString)
  ids?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by state/column ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  columnId?: string | string[];

  @ApiPropertyOptional({ description: 'Alias for columnId' })
  @IsOptional()
  @Transform(toArrayOrString)
  state?: string | string[];

  @ApiPropertyOptional({
    description:
      'Filter by state group(s) (backlog, unstarted, started, completed, cancelled)',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  stateGroup?: string | string[];

  @ApiPropertyOptional({
    description: 'Filter by priority or list of priorities',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  priority?: WorkItemPriority | WorkItemPriority[];

  @ApiPropertyOptional({
    description: 'Filter by assignee user ID(s) or unassigned',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  assigneeId?: string | string[];

  @ApiPropertyOptional({ description: 'Alias for assigneeId' })
  @IsOptional()
  @Transform(toArrayOrString)
  assignees?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by subscriber user ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  subscribers?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by mentioned user ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  mentions?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by label name(s) or ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  labels?: string | string[];

  @ApiPropertyOptional({
    description:
      'Filter by attachment category (has_attachments, pages, papers, files, links)',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  attach?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by creator / author user ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  createdById?: string | string[];

  @ApiPropertyOptional({ description: 'Alias for createdById' })
  @IsOptional()
  @Transform(toArrayOrString)
  authorId?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by parent WorkItem ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  parentWorkItemId?: string | string[];

  @ApiPropertyOptional({ description: 'Alias for parentWorkItemId' })
  @IsOptional()
  @Transform(toArrayOrString)
  parent?: string | string[];

  @ApiPropertyOptional({
    description:
      'Filter by due date (today, this_week, this_month, overdue, no_date, YYYY-MM-DD, from..to)',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  dueDate?: string | string[];

  @ApiPropertyOptional({
    description:
      'Filter by start date (today, this_week, this_month, no_date, YYYY-MM-DD, from..to)',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  startDate?: string | string[];

  @ApiPropertyOptional({
    description:
      'Filter by createdAt date (today, this_week, this_month, this_year, YYYY-MM-DD, from..to)',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  createdAt?: string | string[];

  @ApiPropertyOptional({
    description:
      'Filter by updatedAt date (today, this_week, this_month, this_year, YYYY-MM-DD, from..to)',
  })
  @IsOptional()
  @Transform(toArrayOrString)
  updatedAt?: string | string[];

  @ApiPropertyOptional({
    description:
      'Field to order by (rank, createdAt, updatedAt, priority, dueDate, startDate, title)',
  })
  @IsOptional()
  @IsString()
  orderBy?: string;

  @ApiPropertyOptional({
    description: 'Alias for orderBy',
  })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({
    description: 'Order direction (asc, desc)',
    default: 'asc',
  })
  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc';

  @ApiPropertyOptional({
    description: 'Alias for orderDirection (asc, desc)',
  })
  @IsOptional()
  @IsString()
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({ description: 'Filter by completion state' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  completed?: boolean;

  @ApiPropertyOptional({
    description:
      'Filter by archived status (default false: only active work items)',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({ description: 'Search term for title or identifier' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Page number for pagination',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Number of items per page', example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
