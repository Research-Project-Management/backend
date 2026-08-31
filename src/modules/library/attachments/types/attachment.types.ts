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
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';

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

export function validateAttachmentInvariants(input: {
  url?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
  fileHash?: string;
}): void {
  if (!input.url || input.url.trim() === '') {
    throw new AttachmentInvariantError('Attachment URL cannot be empty.');
  }

  if (input.size !== undefined && input.size < 0) {
    throw new AttachmentInvariantError('Attachment size cannot be negative.');
  }

  if (input.filename !== undefined && input.filename.trim() === '') {
    throw new AttachmentInvariantError('Attachment filename cannot be empty whitespace.');
  }
}
