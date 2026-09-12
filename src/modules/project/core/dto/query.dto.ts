import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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
    description: 'Filter by archived status',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isArchived?: boolean;

  @ApiPropertyOptional({ description: 'Filter by favorite status' })
  @IsBoolean()
  @IsOptional()
  isFavorite?: boolean;
}
