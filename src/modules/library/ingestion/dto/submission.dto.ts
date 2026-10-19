import {
  IsString,
  IsIn,
  IsOptional,
  IsArray,
  IsUUID,
  IsObject,
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
      if (['IDENTIFIER', 'RECORD', 'URL', 'FILE', 'CONNECTOR'].includes(upper)) {
        return upper as SubmissionKind;
      }
    }
    const src = String(obj?.source || '').toLowerCase();
    if (src === 'pdf' || obj?.fileId) return 'FILE';
    if (src === 'doi' || src === 'arxiv' || src === 'isbn' || src === 'pmid' || obj?.doi || obj?.arxivId || obj?.isbn || obj?.pmid) return 'IDENTIFIER';
    if (src === 'bibtex' || src === 'ris' || obj?.format || obj?.recordFormat) return 'RECORD';
    if (src === 'url' || obj?.url) return 'URL';
    if (src === 'zotero' || src === 'connector' || obj?.connectionId) return 'CONNECTOR';
    return value;
  })
  @IsIn(['IDENTIFIER', 'RECORD', 'URL', 'FILE', 'CONNECTOR'])
  kind!: SubmissionKind;

  // Identifier fields
  @IsOptional()
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
    'REFER',
    'bibtex',
    'ris',
    'csl_json',
  ])
  format?: RecordFormat;

  @IsOptional()
  @IsIn([
    'BIBTEX',
    'RIS',
    'CSL_JSON',
    'ENDNOTE_XML',
    'MODS',
    'REFER',
    'bibtex',
    'ris',
    'csl_json',
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
  externalVersion?: string;

  // Common Envelope Options
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
