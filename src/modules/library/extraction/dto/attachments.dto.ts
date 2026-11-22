import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { LinkMode, AttachmentType } from '@prisma/client';

export const SAFE_ATTACHMENT_URL_REGEX = /^(?:https?:\/\/|\/api\/(?!\/))/i;
const SAFE_ATTACHMENT_URL_MSG =
  'Attachment URL must use http://, https://, or a relative /api/... path';

export class CreateAttachmentDto {
  @IsString()
  filename!: string;

  @IsOptional()
  @IsString()
  @Matches(SAFE_ATTACHMENT_URL_REGEX, { message: SAFE_ATTACHMENT_URL_MSG })
  url?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsUUID()
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

  @IsUUID()
  @IsOptional()
  fileId?: string;

  @IsEnum(LinkMode)
  @IsOptional()
  linkMode?: LinkMode;

  @IsEnum(AttachmentType)
  @IsOptional()
  attachmentType?: AttachmentType;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class CaptureSnapshotDto {
  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  title?: string;
}

export class RenameAttachmentDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  filename?: string;

  @IsString()
  @IsOptional()
  pattern?: string;
}

export class BatchRenameAttachmentsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  @IsOptional()
  itemIds?: string[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
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
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

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
  @IsNumber()
  size?: number;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

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
  @IsNumber()
  sizeBytes?: number;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

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

export class BenchmarkPayloadDto {
  @IsOptional()
  @IsString()
  base64Pdf?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  filename?: string;
}
