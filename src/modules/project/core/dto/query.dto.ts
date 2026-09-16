import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ProjectPriority, ProjectState } from '@prisma/client';

/**
 * Query DTO for filtering and searching projects.
 */
export class ProjectQueryDto {
  @ApiPropertyOptional({
    description: 'Filter by membership relationship',
    enum: ['created', 'shared', 'all'],
    default: 'all',
  })
  @IsString()
  @IsIn(['created', 'shared', 'all'])
  @IsOptional()
  type?: 'created' | 'shared' | 'all';

  @ApiPropertyOptional({
    description: 'Search keyword matching project name or description',
  })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by project lifecycle state',
    enum: ProjectState,
  })
  @IsEnum(ProjectState)
  @IsOptional()
  state?: ProjectState;

  @ApiPropertyOptional({
    description: 'Filter by project priority',
    enum: ProjectPriority,
  })
  @IsEnum(ProjectPriority)
  @IsOptional()
  priority?: ProjectPriority;

  @ApiPropertyOptional({
    description: 'Filter by ProjectLabel UUID',
  })
  @IsUUID('4')
  @IsOptional()
  labelId?: string;

  @ApiPropertyOptional({
    description: 'Filter by archived status',
    default: false,
  })
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  isArchived?: boolean;

  @ApiPropertyOptional({ description: 'Filter by favorite status' })
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  @IsOptional()
  isFavorite?: boolean;
}
