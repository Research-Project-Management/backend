import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
  IsBoolean,
  IsUUID,
  IsArray,
  ArrayNotEmpty,
  IsNumber,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RetractionNature } from '@/modules/library/ingestion/types/ingestion.types';

export class UnifiedIngestionDto {
  @IsString()
  @IsIn([
    'doi',
    'arxiv',
    'pmid',
    'isbn',
    'url',
    'bibtex',
    'ris',
    'csl_json',
    'endnote_xml',
    'mods',
    'zotero_rdf',
    'medline',
    'csv',
    'pdf',
    'zotero',
  ])
  source!:
    | 'doi'
    | 'arxiv'
    | 'pmid'
    | 'isbn'
    | 'url'
    | 'bibtex'
    | 'ris'
    | 'csl_json'
    | 'endnote_xml'
    | 'mods'
    | 'zotero_rdf'
    | 'medline'
    | 'csv'
    | 'pdf'
    | 'zotero';

  @IsOptional()
  @IsString()
  doi?: string;

  @IsOptional()
  @IsString()
  arxivId?: string;

  @IsOptional()
  @IsString()
  pmid?: string;

  @IsOptional()
  @IsString()
  isbn?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  previewToken?: string;

  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  content?: string; // For BibTeX, RIS, or raw text

  @IsOptional()
  @IsString()
  bibtex?: string; // Alias for content

  @IsOptional()
  @IsString()
  ris?: string; // Alias for content

  @IsOptional()
  @IsString()
  fileId?: string;

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  connectionId?: string;

  @IsOptional()
  @IsString()
  externalItemKey?: string;

  @IsOptional()
  payload?: unknown;

  @IsOptional()
  @IsBoolean()
  silent?: boolean;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

// ============================================================================
// Curation DTOs
// ============================================================================

export class UpdateReviewCaseStatusDto {
  @IsIn(['OPEN', 'PENDING', 'APPROVED', 'REJECTED', 'DISMISSED', 'RESOLVED'])
  status!:
    | 'OPEN'
    | 'PENDING'
    | 'APPROVED'
    | 'REJECTED'
    | 'DISMISSED'
    | 'RESOLVED';

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

export class MergeDuplicatesDto {
  @IsUUID(undefined, { message: 'primaryItemId must be a valid UUID' })
  primaryItemId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'duplicateItemIds must contain at least one ID' })
  @IsUUID(undefined, {
    each: true,
    message: 'Each duplicateItemId must be a valid UUID',
  })
  duplicateItemIds!: string[];

  @IsOptional()
  @IsObject()
  fieldSelections?: Record<string, unknown>;

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

export class DismissDuplicatesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'itemIds must contain at least two IDs' })
  @IsUUID(undefined, {
    each: true,
    message: 'Each itemId must be a valid UUID',
  })
  itemIds!: string[];

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

// ============================================================================
// Feeds DTOs
// ============================================================================

export class SubscribeFeedDto {
  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customTitle?: string;

  @IsOptional()
  @IsNumber()
  cleanupDays?: number;

  @IsOptional()
  @IsNumber()
  cleanupReadAfter?: number;

  @IsOptional()
  @IsNumber()
  cleanupUnreadAfter?: number;
}

export class UpdateFeedSubDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customTitle?: string;

  @IsOptional()
  @IsNumber()
  cleanupDays?: number;

  @IsOptional()
  @IsNumber()
  cleanupReadAfter?: number;

  @IsOptional()
  @IsNumber()
  cleanupUnreadAfter?: number;

  @IsOptional()
  @IsString()
  url?: string;
}

export class MarkItemReadDto {
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;
}

export class MarkAllReadDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  itemIds!: string[];
}

// ============================================================================
// Retraction DTOs
// ============================================================================

export class FlagRetractionDto {
  @IsOptional()
  @IsIn(['retraction', 'expression_of_concern', 'correction', 'manual'])
  nature?: RetractionNature = 'manual';

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  noticeUrl?: string;

  @IsOptional()
  @IsString()
  date?: string;
}

export class BatchCheckRetractionDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];
}

export class SyncRetractionDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}
