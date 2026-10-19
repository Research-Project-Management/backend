import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CursorPaginationQueryDto {
  @IsOptional()
  @IsString()
  view?:
    | 'all'
    | 'recent'
    | 'unfiled'
    | 'trash'
    | 'my-publications'
    | 'publications'
    | 'starred'
    | 'retracted';

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  tagId?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value))
      return value.map((s) => String(s).trim()).filter(Boolean);
    if (typeof value === 'string')
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return undefined;
  })
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  fields?: string;

  @IsOptional()
  @IsString()
  smartFilter?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  year?: number;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  skip?: number;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @IsString()
  orderBy?:
    | 'title'
    | 'year'
    | 'createdAt'
    | 'updatedAt'
    | 'citationKey'
    | 'publicationTitle'
    | 'firstAuthor'
    | 'authors'
    | 'publication'
    | 'deletedAt'
    | (string & {});

  @IsOptional()
  @IsString()
  orderDirection?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  itemType?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  fromYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  toYear?: number;

  @IsOptional()
  @IsString()
  readStatus?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  hasFile?: boolean;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  hasNotes?: boolean;

  @IsOptional()
  @IsString()
  tag?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value))
      return value.map((s) => String(s).trim()).filter(Boolean);
    if (typeof value === 'string')
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return undefined;
  })
  @IsArray()
  @IsString({ each: true })
  collectionIds?: string[];

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  includeSubcollections?: boolean;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  recursive?: boolean;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  meta: {
    cursor?: string;
    hasNextPage: boolean;
    totalCount?: number;
  };
}

export interface DocumentBoundingBoxDto {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentSectionDto {
  id: string;
  num: string;
  title: string;
  paragraphs: string[];
  page: number;
  coords?: DocumentBoundingBoxDto;
  imradCategory?:
    | 'introduction'
    | 'methods'
    | 'results'
    | 'discussion'
    | 'conclusion'
    | 'other';
}

export interface DocumentFigureDto {
  id: string;
  label: string;
  caption: string;
  page: number;
  coords?: DocumentBoundingBoxDto;
}

export interface DocumentTableDto {
  id: string;
  label: string;
  caption: string;
  page: number;
  coords?: DocumentBoundingBoxDto;
  headers?: string[];
  rows?: string[][];
  markdown?: string;
}

export interface DocumentFormulaDto {
  id: string;
  label?: string;
  text: string;
  page: number;
  coords?: DocumentBoundingBoxDto;
}

export interface DocumentReferenceDto {
  id?: string;
  title?: string;
  authors: string[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  arxivId?: string;
  rawCitation?: string;
}

export interface DocumentFulltextResponse {
  title?: string;
  abstract?: string;
  markdown?: string;
  plainText?: string;
  pageCount?: number;
  sections: DocumentSectionDto[];
  figures: DocumentFigureDto[];
  tables: DocumentTableDto[];
  formulas: DocumentFormulaDto[];
  references: DocumentReferenceDto[];
}
