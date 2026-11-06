import { IsString, IsOptional, IsArray, IsNumber, IsBoolean, Min, Max, IsUUID, ArrayMaxSize, ArrayNotEmpty, MaxLength, IsObject } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

function transformOptionalBoolean(value: unknown): boolean | undefined {
  if (value === 'true' || value === true || value === '1' || value === 1)
    return true;
  if (value === 'false' || value === false || value === '0' || value === 0)
    return false;
  return undefined;
}

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
  searchMode?: 'title_creator_year' | 'fields_tags' | 'everything';

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
  ids?: string[];

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
  @Max(1000)
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
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  hasFile?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  hasPdf?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  hasNotes?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  isStarred?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  onlyFlagged?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  isRead?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  isRetracted?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  unfiled?: boolean;

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
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  includeSubcollections?: boolean;

  @IsOptional()
  @Transform(({ value }) => transformOptionalBoolean(value))
  @IsBoolean()
  recursive?: boolean;

  @IsOptional()
  @IsString()
  checkInProjectId?: string;
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
  pageNumber?: number;
  level?: number;
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
  pages?: Array<{
    pageNumber: number;
    pageIndex?: number;
    text: string;
  }>;
  sections: DocumentSectionDto[];
  figures: DocumentFigureDto[];
  tables: DocumentTableDto[];
  formulas: DocumentFormulaDto[];
  references: DocumentReferenceDto[];
  sectionCount?: number;
  figureCount?: number;
  tableCount?: number;
  formulaCount?: number;
  referenceCount?: number;
}

export class TypeConversionPreviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetItemType?: string;

  @IsOptional()
  @IsBoolean()
  retainUnmappedInExtra?: boolean;
}

export class TypeConversionDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetItemType?: string;

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;

  @IsOptional()
  @IsBoolean()
  retainUnmappedInExtra?: boolean;

  @IsOptional()
  @IsObject()
  customFieldOverrides?: Record<string, unknown>;
}

export class ParseCitationsDto {
  @ApiPropertyOptional({
    description:
      'Raw unformatted citation text or multi-line bibliography string to parse via citation parser',
    example:
      'Vaswani, A., Shazeer, N., Parmar, N., Uszkoreit, J., Jones, L., Gomez, A. N., Kaiser, L., & Polosukhin, I. (2017). Attention is all you need. Advances in neural information processing systems, 30.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100000)
  citations?: string;

  @ApiPropertyOptional({
    description: 'Alias for citations',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100000)
  rawCitations?: string;
}

export class BulkPurgeItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to permanently delete from library/trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  itemIds!: string[];
}

export class BulkTrashItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to move to trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  itemIds!: string[];
}

export class BulkRestoreItemsDto {
  @ApiProperty({
    description: 'Array of item IDs to restore from trash',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  itemIds!: string[];
}

export class ImportItemIdsDto {
  @ApiProperty({
    description: 'Array of item UUIDs to import into project',
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'itemIds must be a non-empty array' })
  @ArrayMaxSize(100, { message: 'itemIds must contain at most 100 IDs' })
  @IsUUID(undefined, { each: true, message: 'Each item ID must be a valid UUID' })
  itemIds!: string[];
}

export class ReResolveMetadataDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  doi?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  arxivId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  pmid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  isbn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;

  @IsOptional()
  @IsBoolean()
  aggressive?: boolean;

  @IsOptional()
  @IsBoolean()
  attachOaPdf?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fields?: string[];

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class LinkItemsDto {
  @IsOptional()
  @IsUUID()
  targetItemId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  targetItemIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  relationType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class MarkMyPublicationDto {
  @IsOptional()
  @IsString()
  contributorId?: string | null;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  openAccessLicense?: string | null;

  @IsOptional()
  @IsBoolean()
  includeAttachments?: boolean;

  @IsOptional()
  @IsBoolean()
  includeNotes?: boolean;

  @IsOptional()
  @IsBoolean()
  authorshipConfirmed?: boolean;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}
