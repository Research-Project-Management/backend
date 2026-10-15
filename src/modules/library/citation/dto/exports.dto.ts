import { IsString, IsOptional, IsArray } from 'class-validator';
import { ExportFormatType } from '@/modules/library/citation/types/exports.types';

export type { ExportFormatType };

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

  @IsOptional()
  @IsString()
  projectId?: string;
}
