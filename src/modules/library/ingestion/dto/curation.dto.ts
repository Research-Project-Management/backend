import {
  IsUUID,
  IsArray,
  ArrayNotEmpty,
  IsOptional,
  IsObject,
  IsString,
  IsBoolean,
  IsNumber,
} from 'class-validator';

export class MergeDuplicatesDto {
  @IsUUID(undefined, { message: 'primaryItemId must be a valid UUID' })
  primaryItemId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'duplicateItemIds must contain at least one ID' })
  @IsUUID(undefined, {
    each: true,
    message: 'Each duplicateItemId must be a valid UUID',
  })
  duplicateItemIds!: string[];

  @IsOptional()
  @IsObject()
  fieldSelections?: Record<string, unknown>;

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

export class DismissDuplicatesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'itemIds must contain at least two IDs' })
  @IsUUID(undefined, {
    each: true,
    message: 'Each itemId must be a valid UUID',
  })
  itemIds!: string[];

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

export class ReResolveMetadataDto {
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
  title?: string;

  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;

  @IsOptional()
  @IsBoolean()
  aggressive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fields?: string[];

  @IsOptional()
  @IsNumber()
  expectedVersion?: number;

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}
