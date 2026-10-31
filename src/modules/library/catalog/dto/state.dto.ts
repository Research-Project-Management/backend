import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { ReadingStatus } from '@/modules/library/catalog/types/state.types';

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
