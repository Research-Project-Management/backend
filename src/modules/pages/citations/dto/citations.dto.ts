/**
 * citations/dto/citations.dto.ts
 * Canonical Request & Response DTOs for Citations & Bibliography operations.
 */

import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { StructuredCitationEntryInput } from '../types/citations.types';
import type { ConflictPolicy } from '../domain/bibtex.domain';

const MAX_RAW_BIBTEX_LENGTH = 2 * 1024 * 1024; // 2MB guardrail
const MAX_BATCH_ENTRIES = 500;

export class CitationQueryDto {
  @ApiPropertyOptional({
    description: 'Search term (matching key, author, title, year)',
  })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  query?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of results to return',
    default: 500,
  })
  @IsNumber()
  @Min(1)
  @Max(2000)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Optional page scope ID' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class ResolveIdentifierDto {
  @ApiProperty({
    description:
      'Academic identifier (DOI like 10.1145/... or arXiv like 1706.03762)',
  })
  @IsString()
  @MaxLength(512)
  @IsNotEmpty({ message: 'identifier is required' })
  identifier!: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename to append to',
    default: 'references.bib',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  targetBibFile?: string;

  @ApiPropertyOptional({ description: 'Optional page scope ID' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class SyncLibraryDto {
  @ApiProperty({ description: 'Collection ID to sync from library' })
  @IsString()
  @MaxLength(255)
  @IsNotEmpty({ message: 'collectionId is required' })
  collectionId!: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename to sync into',
    default: 'references.bib',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  targetBibFile?: string;

  @ApiPropertyOptional({ description: 'Optional page scope ID' })
  @IsString()
  @IsOptional()
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Policy when a citeKey already exists in target .bib',
    enum: ['overwrite', 'skip', 'rename'],
    default: 'overwrite',
  })
  @IsIn(['overwrite', 'skip', 'rename'])
  @IsOptional()
  conflictPolicy?: ConflictPolicy;
}

export class UpsertCitationEntriesDto {
  @ApiPropertyOptional({
    description: 'Structured citation entries to upsert (max 500 per request)',
  })
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_ENTRIES)
  @IsOptional()
  entries?: StructuredCitationEntryInput[];

  @ApiPropertyOptional({
    description:
      'Raw BibTeX string to parse and upsert into the target .bib file (max 2MB)',
  })
  @IsString()
  @MaxLength(MAX_RAW_BIBTEX_LENGTH)
  @IsOptional()
  rawBibtex?: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename',
    default: 'references.bib',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  targetBibFile?: string;

  @ApiPropertyOptional({ description: 'Optional page scope ID' })
  @IsString()
  @IsOptional()
  pageId?: string;

  @ApiPropertyOptional({
    description: 'Policy when a citeKey already exists in target .bib',
    enum: ['overwrite', 'skip', 'rename'],
    default: 'overwrite',
  })
  @IsIn(['overwrite', 'skip', 'rename'])
  @IsOptional()
  conflictPolicy?: ConflictPolicy;
}

export class CitationEntryDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  sourceFile!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: [String] })
  authors!: string[];

  @ApiPropertyOptional()
  year?: string;

  @ApiPropertyOptional()
  journal?: string;

  @ApiPropertyOptional()
  booktitle?: string;

  @ApiPropertyOptional()
  publisher?: string;

  @ApiPropertyOptional()
  volume?: string;

  @ApiPropertyOptional()
  number?: string;

  @ApiPropertyOptional()
  pages?: string;

  @ApiPropertyOptional()
  doi?: string;

  @ApiPropertyOptional()
  url?: string;

  @ApiPropertyOptional()
  abstract?: string;
}

export class ListCitationsResponseDto {
  @ApiProperty({ type: [CitationEntryDto] })
  items!: CitationEntryDto[];

  @ApiProperty()
  total!: number;
}

export class BibMutationResponseDto {
  @ApiProperty()
  filePath!: string;

  @ApiPropertyOptional()
  docId?: string;

  @ApiProperty({ type: [CitationEntryDto] })
  entries!: CitationEntryDto[];

  @ApiProperty({ type: [String] })
  conflicts!: string[];
}
