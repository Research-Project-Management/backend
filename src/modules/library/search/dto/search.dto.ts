import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchCatalogQueryDto {
  @IsString()
  query!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  tagId?: string;
}

export class SavedSearchDto {
  @IsString()
  name!: string;

  @IsString()
  query!: string;

  @IsOptional()
  filters?: Record<string, any>;
}
