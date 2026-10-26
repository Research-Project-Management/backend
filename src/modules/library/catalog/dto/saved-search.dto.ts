import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIn,
  IsObject,
  IsInt,
  Min,
  Max,
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
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
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
  projectId?: string;

  @IsOptional()
  @IsString()
  targetScope?: string;

  @IsOptional()
  @IsString()
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
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
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
  targetScope?: string;

  @IsOptional()
  @IsString()
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
  sortBy?: string;

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
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
  page?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsIn(SAVED_SEARCH_SORT_BY_VALUES)
  sortBy?: SavedSearchSortBy;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  projectId?: string;
}
