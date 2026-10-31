import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsString,
  IsNotEmpty,
  IsOptional,
  MinLength,
  MaxLength,
  IsEnum,
  IsInt,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { TagType } from '@prisma/client';
import { ReadingStatus } from '@/modules/library/catalog/types/catalog.types';

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

  @IsString()
  @IsOptional()
  @MaxLength(100)
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

  @IsString()
  @IsOptional()
  @MaxLength(100)
  projectId?: string;

  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

export interface ReaderScrollPositionDto {
  page?: number;
  zoom?: number;
  fitMode?: string;
  rotation?: number;
  themeMode?: string;
  bookmarks?: number[];
  [key: string]: unknown;
}

export class UpdateStateDto {
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
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  itemIds?: string[];
}
