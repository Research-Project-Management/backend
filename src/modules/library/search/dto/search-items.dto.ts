import { IsString, IsOptional, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';

const parseOptionalBoolean = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const str = String(value).trim().toLowerCase();
  if (str === 'true' || str === '1') return true;
  if (str === 'false' || str === '0') return false;
  return undefined;
};

export class SearchItemsQueryDto {
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything' | string;

  @IsOptional()
  @IsString()
  view?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  includeSubcollections?: boolean;

  @IsOptional()
  @IsString()
  tagId?: string;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  itemType?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  yearFrom?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  yearTo?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  fromYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  toYear?: number;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  hasFile?: boolean;

  @IsOptional()
  @Transform(parseOptionalBoolean)
  @IsBoolean()
  hasNotes?: boolean;

  @IsOptional()
  @IsString()
  readStatus?: string;

  @IsOptional()
  @IsString()
  sortBy?:
    | 'relevance'
    | 'dateAdded'
    | 'createdAt'
    | 'updatedAt'
    | 'year'
    | 'title'
    | 'authors'
    | 'firstAuthor'
    | 'publication'
    | 'publicationTitle'
    | 'citationKey'
    | string;

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  orderBy?: string;

  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc';

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeFacets?: boolean;
}

export class SearchPageAnchorsQueryDto {
  @IsOptional()
  @IsString()
  term?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
  })
  @IsInt()
  @Min(0)
  pageIndex?: number;

  @IsOptional()
  @IsString()
  projectId?: string;
}
