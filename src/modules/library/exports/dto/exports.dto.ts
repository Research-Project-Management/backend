import { IsString, IsOptional, IsArray } from 'class-validator';

export type ExportFormatType =
  'bibtex' | 'ris' | 'csl-json' | 'csv' | 'markdown';

export class ExportLibraryDto {
  @IsString()
  format!: ExportFormatType;

  @IsOptional()
  @IsArray()
  itemIds?: string[];

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  tagId?: string;
}
