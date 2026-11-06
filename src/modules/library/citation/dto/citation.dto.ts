import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  CitationItemInput,
  CitationStyleId,
  ExportFormatType,
} from '../types/citation.types';

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

  @ApiPropertyOptional({ description: 'Pinpoint locator (e.g. page number "42")' })
  @IsOptional()
  @IsString()
  locator?: string;

  @ApiPropertyOptional({ description: 'Locator label (e.g. "page", "chapter", "section")' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({ description: 'In-text citation prefix (e.g. "see ")' })
  @IsOptional()
  @IsString()
  prefix?: string;

  @ApiPropertyOptional({ description: 'In-text citation suffix' })
  @IsOptional()
  @IsString()
  suffix?: string;

  @ApiPropertyOptional({ description: 'Suppress author in in-text citation' })
  @IsOptional()
  @IsBoolean()
  suppressAuthor?: boolean;
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
  @IsUUID('all', { each: true })
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
  @Min(1)
  @Max(5000)
  limit?: number;
}

export class ExportByKeysDto {
  @ApiProperty({ description: 'List of citation keys to export' })
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  keys!: string[];

  @ApiPropertyOptional({ description: 'Project scope ID if exporting from a project' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Export format', example: 'bibtex' })
  @IsOptional()
  @IsString()
  format?: ExportFormatType;
}
