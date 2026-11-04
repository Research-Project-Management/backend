/**
 * citations/dto/citations.dto.ts
 * Data Transfer Objects for Citations & Bibliography operations.
 */

import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsObject,
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
    default: 50,
  })
  @IsNumber()
  @IsOptional()
  limit?: number;
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
}

export class SyncLibraryDto {
  @ApiProperty({ description: 'Collection ID to sync from external library' })
  @IsString()
  @IsNotEmpty({ message: 'collectionId is required' })
  collectionId!: string;

  @ApiPropertyOptional({
    description: 'External reference provider (e.g. zotero, mendeley)',
  })
  @IsString()
  @IsOptional()
  provider?: string;

  @ApiPropertyOptional({
    description: 'Collection display name',
  })
  @IsString()
  @IsOptional()
  collectionName?: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename to sync into',
    default: 'references.bib',
  })
  @IsString()
  @IsOptional()
  targetFilename?: string;

  @ApiPropertyOptional({
    description: 'Target .bib filename alias (frontend SDK targetBibFile)',
    default: 'references.bib',
  })
  @IsString()
  @IsOptional()
  targetBibFile?: string;
}

export class ParseRawBibtexDto {
  @ApiProperty({ description: 'Raw BibTeX text content to parse in memory' })
  @IsString()
  @IsNotEmpty({ message: 'rawBibtex content is required' })
  rawBibtex!: string;
}

export class BibEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  key!: string;

  @ApiProperty()
  entryType!: string;

  @ApiPropertyOptional()
  type?: string;

  @ApiPropertyOptional()
  title?: string;

  @ApiPropertyOptional()
  year?: string;

  @ApiPropertyOptional()
  journal?: string;

  @ApiPropertyOptional()
  doi?: string;

  @ApiPropertyOptional()
  author?: string;

  @ApiProperty()
  authorsDisplay!: string;

  @ApiProperty({ type: [String] })
  authors!: string[];

  @ApiProperty()
  displayLabel!: string;

  @ApiProperty({ type: Object })
  fields!: Record<string, string>;

  @ApiProperty()
  rawBibtex!: string;
}

export class CitationValidationDto {
  @ApiProperty()
  valid!: boolean;

  @ApiPropertyOptional()
  isValid?: boolean;

  @ApiProperty()
  totalFiles!: number;

  @ApiProperty()
  totalEntries!: number;

  @ApiProperty({ type: [String] })
  duplicateKeys!: string[];

  @ApiProperty({ type: [String] })
  warnings!: string[];

  @ApiPropertyOptional()
  missingFieldWarnings?: Array<{ key: string; missingFields: string[] }>;
}

export class SyncLibraryResultDto {
  @ApiProperty()
  collectionId!: string;

  @ApiProperty()
  syncedCount!: number;

  @ApiProperty()
  filePath!: string;

  @ApiPropertyOptional({ type: [String] })
  conflicts?: string[];
}

export class RefactorCitationKeyDto {
  @ApiProperty({ description: 'Current citation key to replace' })
  @IsString()
  @IsNotEmpty({ message: 'oldKey is required' })
  oldKey!: string;

  @ApiProperty({ description: 'New citation key to rename to' })
  @IsString()
  @IsNotEmpty({ message: 'newKey is required' })
  newKey!: string;
}

export class RefactorCitationKeyResultDto {
  @ApiProperty()
  oldKey!: string;

  @ApiProperty()
  newKey!: string;

  @ApiProperty()
  totalReplacements!: number;

  @ApiProperty()
  affectedFiles!: Array<{
    docId: string;
    path: string;
    count: number;
    newContent: string;
  }>;
}

export class UpsertCitationEntriesDto {
  @ApiPropertyOptional({
    description: 'Single structured citation or library item to upsert',
  })
  @IsObject()
  @IsOptional()
  entry?: StructuredCitationEntryInput;

  @ApiPropertyOptional({
    description: 'Multiple structured citations or library items to upsert',
  })
  @IsArray()
  @IsOptional()
  entries?: StructuredCitationEntryInput[];

  @ApiPropertyOptional({
    description: 'Raw BibTeX string to parse and upsert into the target .bib file',
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

  @ApiPropertyOptional({
    description: 'Target .bib filename alias',
    default: 'references.bib',
  })
  @IsString()
  @IsOptional()
  targetFilename?: string;
}

export class UpsertCitationEntriesResultDto {
  @ApiProperty()
  filePath!: string;

  @ApiPropertyOptional()
  docId?: string;

  @ApiProperty()
  syncedCount!: number;

  @ApiProperty({ type: [BibEntryDto] })
  entries!: BibEntryDto[];

  @ApiProperty()
  formattedBibtex!: string;

  @ApiPropertyOptional({ type: [String] })
  conflicts?: string[];
}

export class InjectBibliographyDto {
  @ApiPropertyOptional({
    description: 'Target document ID in project docstore to update directly',
  })
  @IsString()
  @IsOptional()
  docId?: string;

  @ApiPropertyOptional({
    description: 'Current document content (if not reading from docstore)',
  })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({
    description: 'File path hint to auto-detect LaTeX vs Markdown',
  })
  @IsString()
  @IsOptional()
  filePath?: string;

  @ApiPropertyOptional({
    description: 'Explicit format override (latex or markdown)',
  })
  @IsString()
  @IsOptional()
  format?: 'latex' | 'markdown';

  @ApiPropertyOptional({
    description: 'Citation style ID (auto, auto-numeric, ieee, apa, etc.)',
  })
  @IsString()
  @IsOptional()
  styleId?: string;

  @ApiPropertyOptional({
    description: 'Custom section heading title for Markdown',
  })
  @IsString()
  @IsOptional()
  headingTitle?: string;

  @ApiPropertyOptional({
    description: 'Pre-formatted plain bibliography text',
  })
  @IsString()
  @IsOptional()
  bibliographyText?: string;

  @ApiPropertyOptional({
    description: 'Structured list of citations with keys and formatted bibliography strings',
  })
  @IsArray()
  @IsOptional()
  citations?: Array<{
    key?: string;
    inText?: string;
    bibliography?: string;
  }>;
}

