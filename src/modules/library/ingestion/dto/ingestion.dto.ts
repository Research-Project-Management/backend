import { IsString, IsOptional, IsIn, IsObject, IsBoolean, IsUUID, IsArray, ArrayNotEmpty, IsNumber, ArrayMaxSize, MaxLength, ValidateNested, IsUrl, IsNotEmpty } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { RetractionNature, SubmissionKind, IdentifierType, RecordFormat } from '@/modules/library/ingestion/types/ingestion.types';
import { SCHEMA_V42_DATA, ALL_CREATOR_ROLES } from '@/modules/library/core/types/schema.constants';

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

export class ImportOpmlDto {
  @IsString()
  @MaxLength(500000)
  opmlXml!: string;
}

export class BatchMergeDuplicatesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'merges must contain at least one merge group' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MergeDuplicatesDto)
  merges!: MergeDuplicatesDto[];

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
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

export class IngestionSubmissionDto {
  @Transform(({ value, obj }) => {
    if (value && typeof value === 'string') {
      const upper = value.toUpperCase();
      if (
        ['IDENTIFIER', 'RECORD', 'URL', 'FILE', 'CONNECTOR'].includes(upper)
      ) {
        return upper as SubmissionKind;
      }
    }
    const src = String(obj?.source || '').toLowerCase();
    if (src === 'pdf' || obj?.fileId) return 'FILE';
    if (
      src === 'doi' ||
      src === 'arxiv' ||
      src === 'isbn' ||
      src === 'pmid' ||
      obj?.doi ||
      obj?.arxivId ||
      obj?.isbn ||
      obj?.pmid
    )
      return 'IDENTIFIER';
    if (
      src === 'bibtex' ||
      src === 'ris' ||
      src === 'csl_json' ||
      src === 'endnote_xml' ||
      src === 'mods' ||
      src === 'zotero_rdf' ||
      src === 'rdf' ||
      src === 'medline' ||
      src === 'nbib' ||
      src === 'csv' ||
      obj?.format ||
      obj?.recordFormat
    )
      return 'RECORD';
    if (src === 'url' || obj?.url) return 'URL';
    if (src === 'zotero' || src === 'connector' || obj?.connectionId)
      return 'CONNECTOR';
    return value;
  })
  @IsIn(['IDENTIFIER', 'RECORD', 'URL', 'FILE', 'CONNECTOR'])
  kind!: SubmissionKind;

  // Source alias & identifier convenience fields sent by Frontend SDK
  @IsOptional()
  @IsString()
  source?: string;

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
  bibtex?: string;

  @IsOptional()
  @IsString()
  ris?: string;

  // Identifier fields
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(['DOI', 'PMID', 'ARXIV', 'ISBN'])
  identifierType?: IdentifierType;

  @IsOptional()
  @IsString()
  value?: string;

  @IsOptional()
  @IsString()
  identifierValue?: string;

  // Record fields
  @IsOptional()
  @IsIn([
    'BIBTEX',
    'RIS',
    'CSL_JSON',
    'ENDNOTE_XML',
    'MODS',
    'ZOTERO_RDF',
    'RDF',
    'MEDLINE',
    'NBIB',
    'CSV',
    'REFER',
    'bibtex',
    'ris',
    'csl_json',
    'endnote_xml',
    'mods',
    'zotero_rdf',
    'rdf',
    'medline',
    'nbib',
    'csv',
  ])
  format?: RecordFormat;

  @IsOptional()
  @IsIn([
    'BIBTEX',
    'RIS',
    'CSL_JSON',
    'ENDNOTE_XML',
    'MODS',
    'ZOTERO_RDF',
    'RDF',
    'MEDLINE',
    'NBIB',
    'CSV',
    'REFER',
    'bibtex',
    'ris',
    'csl_json',
    'endnote_xml',
    'mods',
    'zotero_rdf',
    'rdf',
    'medline',
    'nbib',
    'csv',
  ])
  recordFormat?: RecordFormat;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  rawRecord?: string;

  // URL fields
  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  previewToken?: string;

  // File fields
  @IsOptional()
  @IsString()
  fileId?: string;

  @IsOptional()
  @IsString()
  filename?: string;

  // Connector fields
  @IsOptional()
  @IsString()
  connectionId?: string;

  @IsOptional()
  @IsString()
  externalObjectId?: string;

  @IsOptional()
  @IsString()
  externalItemKey?: string;

  @IsOptional()
  @IsString()
  externalVersion?: string;

  @IsOptional()
  payload?: unknown;

  // Common Envelope & Extraction Options
  @IsOptional()
  @IsBoolean()
  allowDuplicates?: boolean;

  @IsOptional()
  @IsBoolean()
  autoExtract?: boolean;

  @IsOptional()
  @IsBoolean()
  enableOcr?: boolean;

  @IsOptional()
  @IsBoolean()
  silent?: boolean;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  collectionIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  tagIds?: string[];

  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  contractVersion?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

const VALID_CREATOR_ROLES = Object.keys(ALL_CREATOR_ROLES);
const VALID_ITEM_TYPES = [
  ...Object.keys(SCHEMA_V42_DATA.itemTypes),
  'article',
  'paper',
  'incollection',
  'inproceedings',
  'phdthesis',
  'mastersthesis',
  'techreport',
  'misc',
  'unpublished',
];

export class CreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsNumber()
  fieldMode?: number;

  @IsOptional()
  @IsIn(VALID_CREATOR_ROLES, {
    message: 'creatorType must be a valid Zotero creator role',
  })
  creatorType?: string;
}

export class CaptureUrlDto {
  @IsNotEmpty()
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'Valid HTTP or HTTPS URL is required' },
  )
  @MaxLength(2048)
  url!: string;
}

export class ConfirmCapturedUrlDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15000)
  abstract?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  doi?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsNumber()
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  publicationTitle?: string;

  @IsNotEmpty({ message: 'Cryptographic previewToken is strictly required' })
  @IsString()
  previewToken!: string;

  @IsOptional()
  @IsBoolean()
  userOverride?: boolean;

  @IsOptional()
  @IsBoolean()
  allowDuplicate?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(VALID_ITEM_TYPES, {
    message: 'itemType must be a valid Zotero item type',
  })
  itemType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreatorDto)
  creators?: CreatorDto[];

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class FetchAcademicFeedDto {
  @IsNotEmpty()
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'Valid HTTP or HTTPS URL is required' },
  )
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}
