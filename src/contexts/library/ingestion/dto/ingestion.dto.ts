import { IsString, IsOptional, IsArray } from 'class-validator';

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
}

export class IngestBibtexDto {
  @IsString()
  bibtex!: string;

  @IsOptional()
  @IsString()
  collectionId?: string;
}
