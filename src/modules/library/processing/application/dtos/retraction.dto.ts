import { IsString, IsOptional, IsIn, IsArray } from 'class-validator';
import { RetractionNature } from '../../domain/types/retraction.types';

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
