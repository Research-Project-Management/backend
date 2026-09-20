import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SemanticSearchDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number = 0.25;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export interface SemanticSearchResultItem {
  id: string;
  title: string;
  year?: number | null;
  doi?: string | null;
  itemType?: string | null;
  publicationTitle?: string | null;
  abstract?: string | null;
  similarityScore: number;
  authors?: string[];
}

export interface SemanticSearchResponse {
  results: SemanticSearchResultItem[];
  total: number;
  query: string;
  executionTimeMs: number;
}
