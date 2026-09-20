import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ReadingStatus } from '../../domain/types/state.types';

export class UpdateStateDto {
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
  scrollPosition?: Record<string, unknown> | Array<unknown> | null;
}

export class GetBatchStatesDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  itemIds?: string[];
}
