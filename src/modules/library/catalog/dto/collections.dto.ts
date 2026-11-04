import { ArrayMaxSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf, ValidateNested, IsBoolean, IsIn, MinLength, IsEnum, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { TagType } from '@prisma/client';
import { ReadingStatus } from '@/modules/library/catalog/types/catalog.types';

export class CreateCollectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsUUID()
  projectId?: string | null;
}

export class UpdateCollectionDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  expectedVersion?: number;

  @IsOptional()
  @IsInt()
  version?: number;
}

export class AssignItemsToCollectionDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  itemIds?: string[];
}

export class MoveItemsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  itemIds?: string[];

  @IsOptional()
  @ValidateIf(
    (o: { sourceCollectionId?: string | null }) =>
      o.sourceCollectionId !== null &&
      o.sourceCollectionId !== undefined &&
      o.sourceCollectionId !== '' &&
      o.sourceCollectionId !== 'unfiled' &&
      o.sourceCollectionId !== 'root',
  )
  @IsUUID()
  sourceCollectionId?: string | null;
}

export class ReorderCollectionItemDto {
  @IsUUID()
  id!: string;

  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  orderIndex?: number;
}

export class ReorderCollectionsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderCollectionItemDto)
  collections!: ReorderCollectionItemDto[];
}

export class BulkDetachItemsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  itemIds!: string[];
}

export class CopyCollectionDto {
  @IsOptional()
  @ValidateIf(
    (o: { parentId?: string | null }) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsUUID()
  projectId?: string | null;
}

export class CreateNoteDto {
  @IsOptional()
  @IsUUID()
  itemId?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  contentJson?: Record<string, unknown> | null;

  @IsString()
  @IsOptional()
  @MaxLength(500000)
  contentMd?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  tags?: string[];

  @IsOptional()
  @IsUUID()
  projectId?: string | null;
}

export class UpdateNoteDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  contentJson?: Record<string, unknown> | null;

  @IsString()
  @IsOptional()
  @MaxLength(500000)
  contentMd?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  tags?: string[];

  @Transform(
    ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
      if (typeof value === 'number') return value;
      if (typeof obj?.version === 'number') return obj.version;
      return value;
    },
  )
  @IsInt()
  @IsOptional()
  expectedVersion?: number;

  @IsInt()
  @IsOptional()
  version?: number;
}

export class ExtractNotesFromAnnotationsDto {
  @IsOptional()
  @IsUUID()
  noteId?: string;

  @IsOptional()
  @IsUUID()
  attachmentId?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  annotationIds?: string[];

  @IsOptional()
  tagColor?: boolean | string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  tagColorName?: string;

  @IsBoolean()
  @IsOptional()
  includeComments?: boolean;

  @IsIn(['flux', 'web', 'zotero'])
  @IsOptional()
  protocol?: 'flux' | 'web' | 'zotero';

  @IsString()
  @IsOptional()
  @MaxLength(500)
  webBaseUrl?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(9)
  @IsOptional()
  shortcut?: number | null;

  @IsEnum(TagType)
  @IsOptional()
  type?: TagType;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

export class UpdateTagDto {
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(9)
  @IsOptional()
  shortcut?: number | null;

  @IsEnum(TagType)
  @IsOptional()
  type?: TagType;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

export class SplitTagDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  parts!: string[];

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

export class ReaderBookmarkItemDto {
  @IsInt()
  @Min(1)
  page!: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  createdAt?: string;
}

export interface ReaderScrollPositionDto {
  attachmentId?: string;
  page?: number;
  zoom?: number;
  fitMode?: string;
  rotation?: number;
  themeMode?: string;
  bookmarks?: Array<number | ReaderBookmarkItemDto>;
  byAttachment?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export class UpdateStateDto {
  @IsOptional()
  @IsString()
  attachmentId?: string;

  @IsOptional()
  @IsBoolean()
  isStarred?: boolean;

  @IsOptional()
  @IsEnum(ReadingStatus, {
    message: 'readStatus must be one of: unread, reading, completed',
  })
  readStatus?: ReadingStatus;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'rating must be between 0 and 5' })
  @Max(5, { message: 'rating must be between 0 and 5' })
  rating?: number;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'currentPage must be at least 1' })
  currentPage?: number;

  @IsOptional()
  scrollPosition?:
    | ReaderScrollPositionDto
    | Record<string, unknown>
    | Array<unknown>
    | null;
}

export class GetBatchStatesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  itemIds?: string[];
}
