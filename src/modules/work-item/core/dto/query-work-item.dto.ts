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
import { TaskPriority } from '@prisma/client';

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

  @ApiPropertyOptional({ enum: TaskPriority, description: 'Filter by priority' })
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

  @ApiPropertyOptional({ description: 'Filter by archived status (default false: only active tasks)' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({ description: 'Search term for title or identifier' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Page number for pagination', example: 1 })
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
