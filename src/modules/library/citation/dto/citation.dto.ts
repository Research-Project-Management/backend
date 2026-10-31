import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  IsObject,
  IsBoolean,
  ArrayMaxSize,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CitationItemInput,
  CitationStyleId,
  ExportFormatType,
} from '@/modules/library/citation/types/citation.types';

export type { ExportFormatType };

export class FormatCitationDto {
  @ApiProperty({ description: 'Item metadata to format citation from' })
  @IsNotEmpty()
  @IsObject()
  item!: CitationItemInput;

  @ApiPropertyOptional({
    description: 'Citation style ID (e.g. apa, ieee, nature, harvard)',
    example: 'apa-7th',
  })
  @IsOptional()
  @IsString()
  styleId?: CitationStyleId;

  @ApiPropertyOptional({ description: 'Citation position index', example: 1 })
  @IsOptional()
  @IsNumber()
  index?: number;
}

export class FormatBatchCitationDto {
  @ApiProperty({ description: 'Array of item metadata' })
  @IsArray()
  @IsNotEmpty()
  @ArrayMaxSize(500)
  items!: CitationItemInput[];

  @ApiPropertyOptional({
    description: 'Citation style ID',
    example: 'apa-7th',
  })
  @IsOptional()
  @IsString()
  styleId?: CitationStyleId;
}

export class ExportLibraryDto {
  @IsString()
  format!: ExportFormatType;

  @IsOptional()
  @IsBoolean()
  includeNotes?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  itemIds?: string[];

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  tagId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;
}
