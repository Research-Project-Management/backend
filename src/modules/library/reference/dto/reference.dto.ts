import {
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResolveDoiDto {
  @ApiProperty({
    description: 'DOI identifier (e.g. 10.1038/s41586-020-2649-2 or full URL)',
    example: '10.1038/s41586-020-2649-2',
  })
  @IsString()
  @IsNotEmpty()
  doi!: string;
}

export class CreateReferenceDto {
  @ApiProperty({ description: 'Academic paper / book title' })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({ description: 'List of authors' })
  @IsArray()
  @IsOptional()
  authors?: string[];

  @ApiPropertyOptional({ description: 'Year of publication' })
  @IsInt()
  @IsOptional()
  year?: number;

  @ApiPropertyOptional({ description: 'Digital Object Identifier (DOI)' })
  @IsString()
  @IsOptional()
  doi?: string;

  @ApiPropertyOptional({ description: 'Journal or Container title' })
  @IsString()
  @IsOptional()
  journal?: string;

  @ApiPropertyOptional({ description: 'Publisher name' })
  @IsString()
  @IsOptional()
  publisher?: string;

  @ApiPropertyOptional({ description: 'Volume number' })
  @IsString()
  @IsOptional()
  volume?: string;

  @ApiPropertyOptional({ description: 'Issue or Number' })
  @IsString()
  @IsOptional()
  issue?: string;

  @ApiPropertyOptional({ description: 'Page numbers (e.g. 101-115)' })
  @IsString()
  @IsOptional()
  pages?: string;

  @ApiPropertyOptional({ description: 'Custom citation key' })
  @IsString()
  @IsOptional()
  citationKey?: string;

  @ApiPropertyOptional({ description: 'Abstract summary' })
  @IsString()
  @IsOptional()
  abstract?: string;

  @ApiPropertyOptional({
    description: 'Item type (journalArticle, book, etc.)',
  })
  @IsString()
  @IsOptional()
  itemType?: string;

  @ApiPropertyOptional({ description: 'Collection ID for folder assignment' })
  @IsString()
  @IsOptional()
  collectionId?: string;

  @ApiPropertyOptional({ description: 'Source URL' })
  @IsString()
  @IsOptional()
  url?: string;
}

export class ExportBibtexDto {
  @ApiPropertyOptional({ description: 'Collection ID filter' })
  @IsString()
  @IsOptional()
  collectionId?: string;
}
