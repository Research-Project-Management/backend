import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsBoolean,
  Matches,
} from 'class-validator';
import type {
  LinkMode,
  AttachmentType,
} from '@/modules/library/extraction/types/attachments.types';

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
