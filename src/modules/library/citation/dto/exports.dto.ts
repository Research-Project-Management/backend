import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  ArrayMaxSize,
} from 'class-validator';
import { ExportFormatType } from '@/modules/library/citation/types/exports.types';

export type { ExportFormatType };

export class ExportLibraryDto {
  @IsString()
  format!: ExportFormatType;

  @IsOptional()
  @IsBoolean()
  includeNotes?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
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

  @IsOptional()
  @IsNumber()
  limit?: number;
}
