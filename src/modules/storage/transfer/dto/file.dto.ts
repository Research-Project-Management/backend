import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PresignDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsString()
  @IsOptional()
  contentType?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsString()
  @IsOptional()
  scope?: string;

  @IsString()
  @IsOptional()
  contentHash?: string;

  @IsObject()
  @IsOptional()
  metaData?: Record<string, unknown>;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsNumber()
  @IsOptional()
  sizeBytes?: number;
}

export class CompletePresignedDto {
  @IsString()
  @IsNotEmpty({ message: 'Storage key is required' })
  storageKey!: string;

  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsNumber()
  @IsOptional()
  sizeBytes?: number;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsString()
  @IsOptional()
  scope?: string;

  @IsString()
  @IsOptional()
  contentHash?: string;

  @IsObject()
  @IsOptional()
  metaData?: Record<string, unknown>;
}

export class InitiateMultipartDto {
  @IsString()
  @IsNotEmpty({ message: 'Filename is required' })
  filename!: string;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsNumber()
  @IsOptional()
  totalSize?: number;

  @IsNumber()
  @IsOptional()
  sizeBytes?: number;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  pageId?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsString()
  @IsOptional()
  scope?: string;

  @IsString()
  @IsOptional()
  expectedHash?: string;
}

export class CompletedPartDto {
  @IsNumber()
  partNumber!: number;

  @IsString()
  eTag!: string;
}

export class CompleteMultipartDto {
  @IsString()
  @IsNotEmpty({ message: 'Session ID is required' })
  sessionId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts!: CompletedPartDto[];
}
