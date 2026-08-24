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
    description: 'General query identifier (DOI, arXiv ID, PMID, ISBN, URL, or Title)',
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

  @ApiPropertyOptional({ description: 'Item type (journalArticle, book, etc.)' })
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
