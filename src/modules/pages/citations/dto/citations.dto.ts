/**
 * citations/dto/citations.dto.ts
 * Canonical Request & Response DTOs for Citations & Bibliography operations.
 */

import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { StructuredCitationEntryInput } from '../domain';

export class CitationQueryDto {
  @ApiPropertyOptional({
    description: 'Search term (matching key, author, title, year)',
  })
  @IsString()
  @IsOptional()
  query?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of results to return',
    default: 500,
  })
  @IsNumber()
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
  @IsNotEmpty({ message: 'identifier is required' })
  identifier!: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename to append to',
    default: 'references.bib',
  })
  @IsString()
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
  @IsNotEmpty({ message: 'collectionId is required' })
  collectionId!: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename to sync into',
    default: 'references.bib',
  })
  @IsString()
  @IsOptional()
  targetBibFile?: string;

  @ApiPropertyOptional({ description: 'Optional page scope ID' })
  @IsString()
  @IsOptional()
  pageId?: string;
}

export class UpsertCitationEntriesDto {
  @ApiPropertyOptional({
    description: 'Structured citation entries to upsert',
  })
  @IsArray()
  @IsOptional()
  entries?: StructuredCitationEntryInput[];

  @ApiPropertyOptional({
    description:
      'Raw BibTeX string to parse and upsert into the target .bib file',
  })
  @IsString()
  @IsOptional()
  rawBibtex?: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename',
    default: 'references.bib',
  })
  @IsString()
  @IsOptional()
  targetBibFile?: string;

  @ApiPropertyOptional({ description: 'Optional page scope ID' })
  @IsString()
  @IsOptional()
  pageId?: string;
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
