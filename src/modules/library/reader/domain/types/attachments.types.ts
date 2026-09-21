import { BaseDomainException } from '../../../shared-kernel/core/errors/domain.exception';

export type AttachmentKind = 'stored_file' | 'linked_resource' | 'snapshot';

export type AttachmentType =
  | 'primary_pdf'
  | 'supplementary'
  | 'dataset'
  | 'slides'
  | 'code'
  | 'figure'
  | 'other'
  | 'preview';

export type AttachmentExtractionStatus =
  'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface AttachmentRevisionEntity {
  id: string;
  attachmentId: string;
  revisionNumber: number;
  fileId?: string | null;
  fileHash: string;
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
  attachmentType: AttachmentType;
  uploadedAt: Date;
  extractionStatus: AttachmentExtractionStatus;
  extractionAttempts: number;
  extractionStartedAt?: Date | null;
  extractionCompletedAt?: Date | null;
  extractionLastError?: string | null;
  revisions?: AttachmentRevisionEntity[];
}

export interface CreateAttachmentInput {
  userId?: string;
  projectId?: string;
  itemId?: string;
  filename: string;
  url: string;
  mimeType?: string;
  size?: number | bigint;
  fileHash?: string;
  fileId?: string;
  attachmentType?: AttachmentType;
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
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInvariantError';
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
