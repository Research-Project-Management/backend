import {
  IsString,
  IsOptional,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsBoolean,
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

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
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
  @IsString()
  fileId!: string;

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsObject()
  overrides?: Record<string, any>;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsBoolean()
  silent?: boolean;
}

export class UnifiedIngestionDto {
  @IsString()
  @IsIn(['doi', 'url', 'bibtex', 'pdf'])
  source!: 'doi' | 'url' | 'bibtex' | 'pdf';

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
  fileId?: string;

  @IsOptional()
  @IsString()
  filename?: string;

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsBoolean()
  silent?: boolean;
}
