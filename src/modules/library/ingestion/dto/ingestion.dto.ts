import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  IsNumber,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { LibraryCreatorInput } from '../../metadata/metadata.types';

export enum IngestionSourceType {
  DOI = 'doi',
  BIBTEX = 'bibtex',
  RIS = 'ris',
  PDF = 'pdf',
  STORAGE = 'storage',
  IDENTIFIER = 'identifier',
  MANUAL = 'manual',
}

export class IngestDocumentDto {
  @ApiProperty({ description: 'Workspace ID where document belongs' })
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @ApiProperty({
    description: 'Source Type of ingestion',
    enum: IngestionSourceType,
    example: IngestionSourceType.DOI,
  })
  @IsEnum(IngestionSourceType)
  @IsNotEmpty()
  sourceType!: IngestionSourceType;

  @ApiPropertyOptional({
    description:
      'General query identifier (DOI, arXiv ID, PMID, ISBN, URL, or Title)',
  })
  @IsString()
  @IsOptional()
  query?: string | null;

  @ApiPropertyOptional({
    description: 'DOI string (e.g. 10.1145/3377325.3377498)',
  })
  @IsString()
  @IsOptional()
  doi?: string | null;

  @ApiPropertyOptional({ description: 'Raw BibTeX text string' })
  @IsString()
  @IsOptional()
  bibtex?: string | null;

  @ApiPropertyOptional({ description: 'Raw RIS text string' })
  @IsString()
  @IsOptional()
  ris?: string | null;

  @ApiPropertyOptional({ description: 'Direct PDF URL or asset link' })
  @IsString()
  @IsOptional()
  fileUrl?: string | null;

  @ApiPropertyOptional({ description: 'Original filename' })
  @IsString()
  @IsOptional()
  filename?: string | null;

  @ApiPropertyOptional({ description: 'File size in bytes' })
  @IsNumber()
  @IsOptional()
  size?: number | null;

  @ApiPropertyOptional({ description: 'MIME type' })
  @IsString()
  @IsOptional()
  mimeType?: string | null;

  @ApiPropertyOptional({
    description: 'Storage File ID if already uploaded to storage',
  })
  @IsString()
  @IsOptional()
  storageFileId?: string | null;

  @ApiPropertyOptional({ description: 'Document Title override' })
  @IsString()
  @IsOptional()
  title?: string | null;

  @ApiPropertyOptional({ description: 'Authors array', type: [String] })
  @IsArray()
  @IsOptional()
  authors?: string[] | null;

  @ApiPropertyOptional({
    description: 'Zotero-style creators with creatorType and split/name fields',
  })
  @IsArray()
  @IsOptional()
  creators?: LibraryCreatorInput[] | null;

  @ApiPropertyOptional({ description: 'Publication year' })
  @IsNumber()
  @IsOptional()
  year?: number | null;

  @ApiPropertyOptional({ description: 'Journal, conference, or publisher' })
  @IsString()
  @IsOptional()
  journal?: string | null;

  @ApiPropertyOptional({ description: 'Publisher' })
  @IsString()
  @IsOptional()
  publisher?: string | null;

  @ApiPropertyOptional({ description: 'Volume' })
  @IsString()
  @IsOptional()
  volume?: string | null;

  @ApiPropertyOptional({ description: 'Issue' })
  @IsString()
  @IsOptional()
  issue?: string | null;

  @ApiPropertyOptional({ description: 'Pages' })
  @IsString()
  @IsOptional()
  pages?: string | null;

  @ApiPropertyOptional({ description: 'ISSN' })
  @IsString()
  @IsOptional()
  issn?: string | null;

  @ApiPropertyOptional({ description: 'ISBN' })
  @IsString()
  @IsOptional()
  isbn?: string | null;

  @ApiPropertyOptional({ description: 'URL' })
  @IsString()
  @IsOptional()
  url?: string | null;

  @ApiPropertyOptional({ description: 'Abstract summary' })
  @IsString()
  @IsOptional()
  abstract?: string | null;

  @ApiPropertyOptional({
    description: 'Zotero-compatible alias for abstract',
  })
  @IsString()
  @IsOptional()
  abstractNote?: string | null;

  @ApiPropertyOptional({ description: 'Publication date string' })
  @IsString()
  @IsOptional()
  date?: string | null;

  @ApiPropertyOptional({ description: 'Access date string' })
  @IsString()
  @IsOptional()
  accessDate?: string | null;

  @ApiPropertyOptional({
    description: 'Item type (journalArticle, book, etc.)',
  })
  @IsString()
  @IsOptional()
  itemType?: string | null;

  @ApiPropertyOptional({ description: 'Custom citation key' })
  @IsString()
  @IsOptional()
  citationKey?: string | null;

  @ApiPropertyOptional({
    description: 'Target Collection ID to place document in',
  })
  @IsString()
  @IsOptional()
  collectionId?: string | null;

  @ApiPropertyOptional({
    description: 'Zotero-style collection IDs; the first value is used as collectionId',
    type: [String],
  })
  @IsArray()
  @IsOptional()
  collections?: string[] | null;

  @ApiPropertyOptional({ description: 'Tags / labels array', type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[] | null;

  @ApiPropertyOptional({ description: 'Notes payload' })
  @IsOptional()
  notes?: any;

  @ApiPropertyOptional({ description: 'Primary file metadata descriptor' })
  @IsOptional()
  primaryFile?: {
    fileId?: string | null;
    filename?: string | null;
    url?: string | null;
    size?: number | null;
    mimeType?: string | null;
    linkMode?: 'imported_file' | 'imported_url' | 'linked_file' | 'linked_url';
    md5?: string | null;
    mtime?: number | null;
  } | null;

  @ApiPropertyOptional({
    description: 'Whether to trigger background vector RAG indexing',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  triggerRag?: boolean | null;
}

export class BatchIngestDto {
  @ApiProperty({
    description: 'Array of ingestion payloads',
    type: [IngestDocumentDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IngestDocumentDto)
  items!: IngestDocumentDto[];
}

/**
 * Represents the live state of an async batch ingestion job.
 * Stored in Redis (TTL 24h) and falls back to in-process Map in dev.
 */
export interface IngestionJobStatus {
  jobId: string;
  userId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  total: number;
  processed: number;
  successCount: number;
  failedCount: number;
  progressPercentage: number;
  /** Populated at runtime from IngestionResult — kept as any to avoid circular import */
  successful: any[];
  failed: Array<{ item: IngestDocumentDto; error: string }>;
  createdAt: string;
  completedAt?: string;
}
