/**
 * citations/dto/citations.dto.ts
 * Data Transfer Objects for Citations & Bibliography operations.
 */

import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CitationQueryDto {
  @ApiPropertyOptional({ description: 'Search term (matching key, author, title, year)' })
  @IsString()
  @IsOptional()
  query?: string;

  @ApiPropertyOptional({ description: 'Maximum number of results to return', default: 50 })
  @IsNumber()
  @IsOptional()
  limit?: number;
}

export class ResolveIdentifierDto {
  @ApiProperty({ description: 'Academic identifier (DOI like 10.1145/... or arXiv like 1706.03762)' })
  @IsString()
  @IsNotEmpty({ message: 'identifier is required' })
  identifier!: string;

  @ApiPropertyOptional({ description: 'Target .bib filename to append to', default: 'references.bib' })
  @IsString()
  @IsOptional()
  targetBibFile?: string;
}

export class SyncLibraryDto {
  @ApiProperty({ description: 'Collection ID to sync from external library' })
  @IsString()
  @IsNotEmpty({ message: 'collectionId is required' })
  collectionId!: string;

  @ApiPropertyOptional({ description: 'Target .bib filename to sync into', default: 'references.bib' })
  @IsString()
  @IsOptional()
  targetFilename?: string;
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
  title?: string;

  @ApiPropertyOptional()
  year?: string;

  @ApiPropertyOptional()
  journal?: string;

  @ApiPropertyOptional()
  doi?: string;

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

  @ApiProperty()
  totalFiles!: number;

  @ApiProperty()
  totalEntries!: number;

  @ApiProperty({ type: [String] })
  duplicateKeys!: string[];

  @ApiProperty({ type: [String] })
  warnings!: string[];
}

export class SyncLibraryResultDto {
  @ApiProperty()
  collectionId!: string;

  @ApiProperty()
  syncedCount!: number;

  @ApiProperty()
  filePath!: string;
}
