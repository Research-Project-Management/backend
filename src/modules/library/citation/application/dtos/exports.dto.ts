import { IsString, IsOptional, IsArray } from 'class-validator';
import { ExportFormatType } from '../../domain/types/exports.types';

export { ExportFormatType };

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
