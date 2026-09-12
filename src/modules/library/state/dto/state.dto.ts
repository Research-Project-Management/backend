import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ReadingStatus } from '../types/state.types';

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
}

export const UpdateReadingDto = UpdateStateDto;
export type UpdateReadingDto = UpdateStateDto;

export class GetBatchStatesDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  itemIds?: string[];
}

export const GetBatchReadingStatesDto = GetBatchStatesDto;
export type GetBatchReadingStatesDto = GetBatchStatesDto;
