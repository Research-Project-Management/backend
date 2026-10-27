import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIn,
  IsObject,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SavedSearchConditionGroup,
  SavedSearchScopeOptions,
} from '@/modules/library/catalog/types/saved-search.types';

const SAVED_SEARCH_SORT_BY_VALUES = [
  'dateAdded',
  'createdAt',
  'year',
  'title',
  'creator',
  'authors',
  'updatedAt',
] as const;

export type SavedSearchSortBy = (typeof SAVED_SEARCH_SORT_BY_VALUES)[number];

export class CreateSavedSearchDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsObject()
  conditions!: SavedSearchConditionGroup;

  @IsOptional()
  @IsObject()
  scopeOptions?: SavedSearchScopeOptions;

  @IsOptional()
  @IsIn(['AND', 'OR'])
  conjunction?: 'AND' | 'OR';

  @IsOptional()
  @IsIn(SAVED_SEARCH_SORT_BY_VALUES)
  sortBy?: SavedSearchSortBy;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  targetScope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  scope?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expectedVersion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

export class UpdateSavedSearchDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsOptional()
  @IsObject()
  conditions?: SavedSearchConditionGroup;

  @IsOptional()
  @IsObject()
  scopeOptions?: SavedSearchScopeOptions;

  @IsOptional()
  @IsIn(['AND', 'OR'])
  conjunction?: 'AND' | 'OR';

  @IsOptional()
  @IsIn(SAVED_SEARCH_SORT_BY_VALUES)
  sortBy?: SavedSearchSortBy;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  targetScope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  scope?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expectedVersion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

export class PreviewSavedSearchDto {
  @IsObject()
  conditions!: SavedSearchConditionGroup;

  @IsOptional()
  @IsObject()
  scopeOptions?: SavedSearchScopeOptions;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  sortBy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;
}

export class ExecuteSavedSearchQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @IsOptional()
  @IsIn(SAVED_SEARCH_SORT_BY_VALUES)
  sortBy?: SavedSearchSortBy;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;
}
