import {
  IsString,
  IsOptional,
  IsIn,
  IsObject,
  IsBoolean,
} from 'class-validator';


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

export * from './submission.dto';
export * from './capture-url.dto';
