import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsObject,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ViewAccess } from '@prisma/client';

export class CreateViewDto {
  @ApiProperty({
    description: 'Name of the saved view',
    example: 'Urgent Bugs & Blockers',
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional description of what this view is for',
    example: 'Filters for all high and urgent priority bugs currently open',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Filter parameters applied to work items in this view',
    example: { priority: ['urgent', 'high'] },
  })
  @IsOptional()
  @IsObject()
  query?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Filter parameters (Plane.so alias for query)',
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Display options such as layout, grouping, ordering',
    example: { layout: 'board', groupBy: 'state', orderBy: 'priority' },
  })
  @IsOptional()
  @IsObject()
  displayFilters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Display properties configuration (Plane.so compatibility)',
  })
  @IsOptional()
  @IsObject()
  displayProperties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Rich filters using operators and logical expressions',
  })
  @IsOptional()
  @IsObject()
  richFilters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Sort order for display order of views',
    example: 65535,
  })
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'Logo props icon configuration',
  })
  @IsOptional()
  @IsObject()
  logoProps?: Record<string, any>;

  @ApiPropertyOptional({
    enum: ViewAccess,
    default: ViewAccess.public,
    description: 'Access visibility for this view: public (all project members) or private (author only)',
  })
  @IsOptional()
  @IsEnum(ViewAccess)
  access?: ViewAccess;
}

export class UpdateViewDto {
  @ApiPropertyOptional({
    description: 'Name of the saved view',
    example: 'Updated View Name',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({
    description: 'Description of the saved view',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Filter parameters applied to work items',
  })
  @IsOptional()
  @IsObject()
  query?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Filter parameters (Plane.so alias for query)',
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Display options such as layout, grouping, ordering',
  })
  @IsOptional()
  @IsObject()
  displayFilters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Display properties configuration (Plane.so compatibility)',
  })
  @IsOptional()
  @IsObject()
  displayProperties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Rich filters using operators and logical expressions',
  })
  @IsOptional()
  @IsObject()
  richFilters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Sort order',
  })
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'Logo props',
  })
  @IsOptional()
  @IsObject()
  logoProps?: Record<string, any>;

  @ApiPropertyOptional({
    enum: ViewAccess,
    description: 'Access visibility',
  })
  @IsOptional()
  @IsEnum(ViewAccess)
  access?: ViewAccess;

  @ApiPropertyOptional({
    description: 'Lock view to prevent modifications by non-authors / non-admins',
  })
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  @ApiPropertyOptional({
    description: 'Archived timestamp',
  })
  @IsOptional()
  archivedAt?: string | null;
}

export class CreateFavoriteViewDto {
  @ApiPropertyOptional({
    description: 'View ID to favorite (Plane.so property name: view)',
    example: 'e2b3c4d5-6789-0123-4567-89abcdef0123',
  })
  @IsOptional()
  @IsString()
  view?: string;

  @ApiPropertyOptional({
    description: 'View ID to favorite (alternative naming)',
  })
  @IsOptional()
  @IsString()
  viewId?: string;
}

export class QueryViewDto {
  @ApiPropertyOptional({
    description: 'Search string to filter views by name or description',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: ViewAccess,
    description: 'Filter by access type (public | private)',
  })
  @IsOptional()
  @IsEnum(ViewAccess)
  access?: ViewAccess;

  @ApiPropertyOptional({
    description: 'Filter to only favorited views by the current user',
  })
  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;
}
