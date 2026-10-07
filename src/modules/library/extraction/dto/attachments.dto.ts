import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';
import type { LinkMode, AttachmentType } from '../types/attachments.types';

export class CreateAttachmentDto {
  @IsString()
  filename!: string;

  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  itemId?: string;

  @IsString()
  @IsOptional()
  mimeType?: string;

  @IsNumber()
  @IsOptional()
  size?: number;

  @IsString()
  @IsOptional()
  fileHash?: string;

  @IsString()
  @IsOptional()
  fileId?: string;

  @IsString()
  @IsOptional()
  linkMode?: LinkMode;

  @IsString()
  @IsOptional()
  attachmentType?: AttachmentType;
}

export class ReplaceAttachmentFileDto {
  @IsString()
  @IsOptional()
  fileId?: string;

  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  fileHash?: string;

  @IsNumber()
  @IsOptional()
  sizeBytes?: number;

  @IsString()
  @IsOptional()
  comment?: string;
}

export class RenameAttachmentDto {
  @IsString()
  @IsOptional()
  filename?: string;

  @IsString()
  @IsOptional()
  pattern?: string;
}

export class BatchRenameAttachmentsDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  itemIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  attachmentIds?: string[];

  @IsString()
  @IsOptional()
  pattern?: string;
}

export class PresignUploadDto {
  @IsString()
  filename!: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsNumber()
  sizeBytes?: number;

  @IsOptional()
  @IsString()
  contentHash?: string;
}

export class CompletePresignDto {
  @IsString()
  storageKey!: string;

  @IsString()
  filename!: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsNumber()
  sizeBytes?: number;

  @IsOptional()
  @IsString()
  contentHash?: string;
}

export class InitiateMultipartDto {
  @IsString()
  filename!: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsNumber()
  totalSize!: number;

  @IsOptional()
  @IsString()
  expectedHash?: string;
}

export class CompleteMultipartDto {
  @IsString()
  sessionId!: string;

  @IsArray()
  parts!: { partNumber: number; eTag: string }[];
}
