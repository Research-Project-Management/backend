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
import { SavedSearchConditionGroup } from '../types/saved-search.types';

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
  @IsIn(['AND', 'OR'])
  conjunction?: 'AND' | 'OR';

  @IsOptional()
  @IsIn(['dateAdded', 'year', 'title', 'creator'])
  sortBy?: 'dateAdded' | 'year' | 'title' | 'creator';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
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
  @IsIn(['AND', 'OR'])
  conjunction?: 'AND' | 'OR';

  @IsOptional()
  @IsIn(['dateAdded', 'year', 'title', 'creator'])
  sortBy?: 'dateAdded' | 'year' | 'title' | 'creator';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}

export class PreviewSavedSearchDto {
  @IsObject()
  conditions!: SavedSearchConditionGroup;
}

export class ExecuteSavedSearchQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsIn(['dateAdded', 'year', 'title', 'creator'])
  sortBy?: 'dateAdded' | 'year' | 'title' | 'creator';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
