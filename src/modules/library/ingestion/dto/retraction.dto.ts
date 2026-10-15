import { IsString, IsOptional, IsIn, IsArray, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';
import { RetractionNature } from '@/modules/library/ingestion/types/retraction.types';

export class FlagRetractionDto {
  @IsOptional()
  @IsIn(['retraction', 'expression_of_concern', 'correction', 'manual'])
  nature?: RetractionNature = 'manual';

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  noticeUrl?: string;

  @IsOptional()
  @IsString()
  date?: string;
}

export class BatchCheckRetractionDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];
}

export class SyncRetractionDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}
