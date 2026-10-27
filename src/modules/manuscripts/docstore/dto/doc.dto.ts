/**
 * modules/manuscripts/docstore/dto/doc.dto.ts
 * Data Transfer Objects for Manuscripts Docstore REST endpoints.
 * Matches Overleaf HttpController request/response schemas.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsDateString,
} from 'class-validator';
import { DocRanges } from '../domain';

export class CreateDocDto {
  @ApiProperty({
    description:
      'Relative path of the document (e.g. main.tex, chapters/intro.tex)',
  })
  @IsString()
  path!: string;

  @ApiPropertyOptional({
    description: 'Lines array of document text',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  lines?: string[];

  @ApiPropertyOptional({
    description: 'Raw document text (alternative to lines)',
  })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ description: 'Starting version sequence' })
  @IsOptional()
  @IsNumber()
  version?: number;

  @ApiPropertyOptional({ description: 'Initial ranges metadata' })
  @IsOptional()
  ranges?: DocRanges;

  tx?: unknown;
}

export class UpdateDocDto {
  @ApiProperty({
    description: 'Updated lines array of document text',
    type: [String],
  })
  @IsArray()
  lines!: string[];

  @ApiPropertyOptional({
    description: 'Version sequence number (auto-incremented if omitted)',
  })
  @IsOptional()
  @IsNumber()
  version?: number;

  @ApiPropertyOptional({
    description: 'Updated track changes and inline comments ranges',
  })
  @IsOptional()
  ranges?: DocRanges;

  @ApiPropertyOptional({
    description: 'Expected revision number for Optimistic Concurrency Control',
  })
  @IsOptional()
  @IsNumber()
  expectedRev?: number;

  @ApiPropertyOptional({
    description: 'Expected revision number alias (frontend SDK rev)',
  })
  @IsOptional()
  @IsNumber()
  rev?: number;
}

export class PatchDocDto {
  @ApiPropertyOptional({ description: 'Soft-delete flag' })
  @IsOptional()
  @IsBoolean()
  deleted?: boolean;

  @ApiPropertyOptional({ description: 'Renamed path of the document' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Renamed path of the document (alias)' })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional({ description: 'Ranges metadata update' })
  @IsOptional()
  ranges?: DocRanges;

  @ApiPropertyOptional({ description: 'Timestamp of deletion' })
  @IsOptional()
  @IsDateString()
  deletedAt?: string;
}

export class DocResponseDto {
  @ApiProperty({ description: 'Unique document identifier' })
  _id!: string;

  @ApiPropertyOptional({ description: 'Alias for _id' })
  id?: string;

  @ApiPropertyOptional({ description: 'Owning project identifier' })
  projectId?: string;

  @ApiProperty({ description: 'Relative file path' })
  path!: string;

  @ApiProperty({ description: 'Document lines array', type: [String] })
  lines!: string[];

  @ApiProperty({ description: 'Optimistic Concurrency revision counter' })
  rev!: number;

  @ApiProperty({ description: 'Realtime collaboration version counter' })
  version!: number;

  @ApiProperty({ description: 'Track changes and inline comment ranges' })
  ranges!: DocRanges;

  @ApiProperty({ description: 'Content cryptographic hash' })
  hash!: string;

  @ApiProperty({ description: 'Total byte length' })
  sizeBytes!: number;

  @ApiProperty({
    description: 'Indicates whether content is stored in S3 cold tier',
  })
  inStorage!: boolean;

  @ApiProperty({
    description: 'Indicates whether document has been soft-deleted',
  })
  deleted!: boolean;
}
