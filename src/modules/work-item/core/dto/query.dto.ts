import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WorkItemPriority } from '@prisma/client';

const toArrayOrString = ({
  value,
}: {
  value: any;
}): string | string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    return value
      .map(String)
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
  return [String(value)];
};

export class QueryWorkItemDto {
  @ApiPropertyOptional({ description: 'Filter by cycle ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  cycleId?: string | string[];

  @ApiPropertyOptional({ description: 'Alias for cycleId' })
  @IsOptional()
  @Transform(toArrayOrString)
  cycle?: string | string[];

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

  @ApiPropertyOptional({ description: 'Filter by label name(s) or ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  labels?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by creator / author user ID(s)' })
  @IsOptional()
  @Transform(toArrayOrString)
  createdById?: string | string[];

  @ApiPropertyOptional({ description: 'Alias for createdById' })
  @IsOptional()
  @Transform(toArrayOrString)
  authorId?: string | string[];

  @ApiPropertyOptional({ description: 'Filter by parent WorkItem ID' })
  @IsOptional()
  @IsString()
  parentWorkItemId?: string;

  @ApiPropertyOptional({
    description:
      'Filter by due date (today, this_week, this_month, overdue, no_date)',
  })
  @IsOptional()
  @IsString()
  dueDate?: string;

  @ApiPropertyOptional({
    description: 'Filter by start date (today, this_week, this_month, no_date)',
  })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({
    description:
      'Field to order by (rank, createdAt, updatedAt, priority, dueDate, startDate, title)',
  })
  @IsOptional()
  @IsString()
  orderBy?: string;

  @ApiPropertyOptional({
    description: 'Order direction (asc, desc)',
    default: 'asc',
  })
  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc';

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

export const QueryDto = QueryWorkItemDto;
export type QueryDto = QueryWorkItemDto;
