import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SearchDiscoveryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  itemType?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  tagId?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  yearFrom?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  yearTo?: number;

  @IsOptional()
  @IsString()
  sortBy?: 'relevance' | 'dateAdded' | 'year' | 'title';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class CreateSavedSearchDto {
  @IsString()
  name!: string;

  @IsObject()
  query!: Record<string, any>;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string;
}

export class PageAnchorSearchDto {
  @IsString()
  attachmentId!: string;

  @IsString()
  term!: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pageIndex?: number;
}
