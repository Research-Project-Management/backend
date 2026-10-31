import {
  IsString,
  IsIn,
  IsOptional,
  IsArray,
  IsUUID,
  IsObject,
  IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';
import {
  SubmissionKind,
  IdentifierType,
  RecordFormat,
} from '@/modules/library/ingestion/types/submission.types';

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
