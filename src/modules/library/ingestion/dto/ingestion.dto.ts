import {
  IsString,
  IsOptional,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
} from 'class-validator';

export class StartIngestionDto {
  @IsString()
  sourceType!: string; // DOI, BIBTEX, PDF, RIS, URL

  @IsOptional()
  @IsString()
  rawInput?: string;

  @IsOptional()
  @IsArray()
  items?: Record<string, any>[];
}

export class IngestDoiDto {
  @IsString()
  doi!: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class IngestBibtexDto {
  @IsString()
  bibtex!: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class IngestPdfDto {
  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  fileUrl?: string;

  @IsOptional()
  @IsString()
  fileId?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsString()
  fileHash?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsObject()
  extractedMeta?: Record<string, any>;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class UnifiedIngestionDto {
  @IsString()
  @IsIn(['doi', 'url', 'bibtex', 'pdf', 'zotero'])
  source!: 'doi' | 'url' | 'bibtex' | 'pdf' | 'zotero';

  @IsOptional()
  @IsString()
  doi?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  previewToken?: string;

  @IsOptional()
  @IsObject()
  overrides?: Record<string, any>;

  @IsOptional()
  @IsString()
  content?: string; // For BibTeX or raw text

  @IsOptional()
  @IsString()
  bibtex?: string; // Alias for content

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  fileUrl?: string;

  @IsOptional()
  @IsString()
  fileId?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsString()
  fileHash?: string;

  @IsOptional()
  @IsObject()
  extractedMeta?: Record<string, any>;

  @IsOptional()
  @IsString()
  connectionId?: string;

  @IsOptional()
  @IsString()
  externalItemKey?: string;

  @IsOptional()
  payload?: unknown;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
