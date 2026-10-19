import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
} from 'class-validator';

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
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

