import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsOptional,
  IsArray,
  IsUUID,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SubmissionKind,
  IdentifierType,
  RecordFormat,
} from '../types/ingestion-submission.types';

export class IdentifierPayloadDto {
  @IsIn(['IDENTIFIER'])
  kind!: 'IDENTIFIER';

  @IsIn(['DOI', 'PMID', 'ARXIV', 'ISBN'])
  identifierType!: IdentifierType;

  @IsString()
  @IsNotEmpty()
  value!: string;
}

export class RecordPayloadDto {
  @IsIn(['RECORD'])
  kind!: 'RECORD';

  @IsIn(['BIBTEX', 'RIS', 'CSL_JSON'])
  format!: RecordFormat;

  @IsString()
  @IsNotEmpty()
  content!: string;
}

export class UrlPayloadDto {
  @IsIn(['URL'])
  kind!: 'URL';

  @IsString()
  @IsNotEmpty()
  url!: string;

  @IsOptional()
  @IsString()
  previewToken?: string;
}

export class FilePayloadDto {
  @IsIn(['FILE'])
  kind!: 'FILE';

  @IsString()
  @IsNotEmpty()
  fileId!: string;

  @IsOptional()
  @IsString()
  filename?: string;
}

export class ConnectorPayloadDto {
  @IsIn(['CONNECTOR'])
  kind!: 'CONNECTOR';

  @IsString()
  @IsNotEmpty()
  connectionId!: string;

  @IsString()
  @IsNotEmpty()
  externalObjectId!: string;

  @IsString()
  @IsNotEmpty()
  externalVersion!: string;
}

export class IngestionSubmissionDto {
  @IsIn(['IDENTIFIER', 'RECORD', 'URL', 'FILE', 'CONNECTOR'])
  kind!: SubmissionKind;

  // Identifier fields
  @IsOptional()
  @IsIn(['DOI', 'PMID', 'ARXIV', 'ISBN'])
  identifierType?: IdentifierType;

  @IsOptional()
  @IsString()
  value?: string;

  // Record fields
  @IsOptional()
  @IsIn(['BIBTEX', 'RIS', 'CSL_JSON'])
  format?: RecordFormat;

  @IsOptional()
  @IsString()
  content?: string;

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
  @IsArray()
  @IsUUID('4', { each: true })
  collectionIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  tagIds?: string[];

  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  contractVersion?: string;
}
