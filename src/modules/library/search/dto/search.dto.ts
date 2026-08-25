import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchCatalogQueryDto {
  @ApiProperty({
    description:
      'Search term or keywords across title, abstract, authors, and DOI',
  })
  @IsString()
  @IsNotEmpty()
  query!: string;

  @ApiPropertyOptional({ description: 'Filter by collection ID' })
  @IsString()
  @IsOptional()
  collectionId?: string;

  @ApiPropertyOptional({
    description: 'Number of results to return (default 20)',
    default: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Number of results to skip (default 0)',
    default: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  skip?: number = 0;
}
