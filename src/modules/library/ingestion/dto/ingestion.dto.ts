import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
  IsBoolean,
  IsUUID,
  IsArray,
  IsNumber,
  ArrayMaxSize,
  MaxLength,
  ValidateNested,
  IsUrl,
  IsNotEmpty,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import {
  SubmissionKind,
  IdentifierType,
  RecordFormat,
} from '@/modules/library/ingestion/types/ingestion.types';
import {
  SCHEMA_V42_DATA,
  ALL_CREATOR_ROLES,
} from '@/modules/library/core/types/schema.constants';

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
  spaceId?: string;
}

// ============================================================================
// Curation DTOs
// ============================================================================

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
  spaceId?: string;
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
  spaceId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
