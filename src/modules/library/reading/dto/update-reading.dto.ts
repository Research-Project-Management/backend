import { IsEnum, IsInt, IsOptional, Min, Max } from 'class-validator';
import { ReadingStatus } from '../types/reading.types';

export class UpdateReadingDto {
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
