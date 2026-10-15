import { BaseDomainException } from '@/modules/library/shared-kernel/core/errors/domain.exception';
import type { AttachmentExtractionStatus as PrismaExtractionStatus } from '@prisma/client';
import type { AttachmentsRepository } from '@/modules/library/extraction/repositories/attachments.repository';

export const ATTACHMENT_REPOSITORY_PORT = Symbol('ATTACHMENT_REPOSITORY_PORT');
export type IAttachmentRepositoryPort = AttachmentsRepository;

export type AttachmentKind = 'stored_file' | 'linked_resource' | 'snapshot';

export type LinkMode =
  'imported_file' | 'imported_url' | 'linked_url' | 'linked_file';

export type AttachmentType =
  | 'primary_pdf'
  | 'supplementary'
  | 'dataset'
  | 'slides'
  | 'code'
  | 'figure'
  | 'snapshot'
  | 'other'
  | 'preview';

export type AttachmentExtractionStatus = PrismaExtractionStatus;

export interface AttachmentRevisionEntity {
  id: string;
  attachmentId: string;
  revisionNumber: number;
  fileId?: string | null;
  fileHash?: string | null;
  sizeBytes: number | bigint;
  url: string;
  comment?: string | null;
  createdAt: Date;
}

export interface AttachmentEntity {
  id: string;
  itemId: string;
  fileId?: string | null;
  filename: string;
  url: string;
  fileHash?: string | null;
  size: number | bigint;
  mimeType: string;
  linkMode?: LinkMode;
  attachmentType: AttachmentType;
  uploadedAt?: Date;
  createdAt?: Date;
  extractionStatus?: AttachmentExtractionStatus;
  extractionAttempts?: number;
  extractionStartedAt?: Date | null;
  extractionCompletedAt?: Date | null;
  extractionLastError?: string | null;
  revisions?: AttachmentRevisionEntity[];
}

export interface CreateAttachmentInput {
  userId?: string;
  projectId?: string;
  itemId?: string;
  title?: string;
  filename: string;
  url?: string;
  mimeType?: string;
  size?: number | bigint;
  fileHash?: string;
  fileId?: string;
  linkMode?: LinkMode;
  attachmentType?: AttachmentType;
  isPrimary?: boolean;
}

export interface ReplaceAttachmentFileInput {
  fileId?: string;
  filename?: string;
  url?: string;
  fileHash?: string;
  sizeBytes?: number | bigint;
  comment?: string;
}

export class AttachmentInvariantError extends BaseDomainException {
  public override name = 'AttachmentInvariantError';
  constructor(message: string) {
    super(message);
  }
}

export class AttachmentTooLargeException extends BaseDomainException {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(`File size (${size} bytes) exceeds maximum limit (${limit} bytes)`);
    this.size = size;
    this.limit = limit;
  }
}

export class InvalidAttachmentTypeException extends BaseDomainException {
  readonly mimeType: string;

  constructor(mimeType: string) {
    super(`MIME type "${mimeType}" is not an allowed attachment format`);
    this.mimeType = mimeType;
  }
}

export class MissingAttachmentFileException extends BaseDomainException {
  constructor() {
    super('No file uploaded or provided');
  }
}

export class AttachmentStorageException extends BaseDomainException {
  constructor(message: string) {
    super(message);
  }
}
