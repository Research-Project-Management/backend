import { HttpException, HttpStatus } from '@nestjs/common';

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
  fileHash: string;
  sizeBytes: number;
  url: string;
  comment?: string | null;
  createdAt: Date;
}

export interface CatalogAttachmentEntity {
  id: string;
  catalogItemId: string;
  fileId?: string | null;
  filename: string;
  url: string;
  fileHash?: string | null;
  size: number;
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
  workspaceId: string;
  catalogItemId: string;
  filename: string;
  url: string;
  mimeType?: string;
  size?: number;
  fileHash?: string;
  fileId?: string;
  attachmentType?: AttachmentType;
}

export interface ReplaceAttachmentFileInput {
  url: string;
  fileHash: string;
  sizeBytes: number;
  comment?: string;
}

export class AttachmentInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInvariantError';
  }
}

export class AttachmentTooLargeException extends HttpException {
  constructor(size: number, limit: number) {
    super(
      `File size (${size} bytes) exceeds maximum limit (${limit} bytes)`,
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
}

export class InvalidAttachmentTypeException extends HttpException {
  constructor(mimeType: string) {
    super(
      `MIME type "${mimeType}" is not an allowed attachment format`,
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    );
  }
}

export class MissingAttachmentFileException extends HttpException {
  constructor() {
    super('No file uploaded or provided', HttpStatus.BAD_REQUEST);
  }
}

export class AttachmentStorageException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
