import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReadingStatus } from '@/modules/library/catalog/types/catalog.types';

interface ReaderScrollPositionDto {
  attachmentId?: string;
  page?: number;
  zoom?: number;
  fitMode?: string;
  rotation?: number;
  themeMode?: string;
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
    ReaderScrollPositionDto | Record<string, unknown> | Array<unknown> | null;
}

export class GetBatchStatesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  itemIds?: string[];
}

export class ValidateItemPayloadDto {
  @IsString()
  @MaxLength(100)
  itemType!: string;

  @IsObject()
  data!: Record<string, unknown>;
}
