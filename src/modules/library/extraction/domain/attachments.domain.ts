import { createHash } from 'crypto';
import {
  AttachmentType,
  AttachmentInvariantError,
} from '@/modules/library/extraction/types/attachments.types';

/**
 * Computes SHA-256 hex digest of a file buffer.
 */
export function calculateFileChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Sanitizes a filename, removing path traversal sequences and invalid characters.
 */
export function sanitizeFilename(filename?: string): string {
  if (!filename) return 'unnamed_attachment';
  const clean = filename
    .replace(/[/\\]/g, '_')
    .split('')
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim();

  return clean || 'unnamed_attachment';
}

/**
 * Validates domain invariant rules for creating an attachment.
 */
export function validateAttachmentInvariants(input: {
  url?: string;
  filename?: string;
  size?: number | bigint;
  mimeType?: string;
  fileHash?: string;
  fileId?: string;
}): void {
  if ((!input.url || input.url.trim() === '') && !input.fileId) {
    throw new AttachmentInvariantError(
      'Attachment URL or fileId must be provided.',
    );
  }

  if (input.size !== undefined && input.size < 0) {
    throw new AttachmentInvariantError('Attachment size cannot be negative.');
  }

  if (input.filename !== undefined && input.filename.trim() === '') {
    throw new AttachmentInvariantError(
      'Attachment filename cannot be empty whitespace.',
    );
  }
}

/**
 * Infers attachment type (primary_pdf, slides, code, etc.) from file extension.
 */
export function inferAttachmentTypeFromFilename(
  filename: string,
): AttachmentType {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'primary_pdf';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'snapshot';
  if (
    lower.endsWith('.pptx') ||
    lower.endsWith('.ppt') ||
    lower.endsWith('.key')
  )
    return 'slides';
  if (
    lower.endsWith('.zip') ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.py') ||
    lower.endsWith('.ipynb')
  )
    return 'code';
  if (
    lower.endsWith('.csv') ||
    lower.endsWith('.xlsx') ||
    lower.endsWith('.json') ||
    lower.endsWith('.parquet')
  )
    return 'dataset';
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.svg')
  )
    return 'figure';
  return 'supplementary';
}

/**
 * Validates MD5 (32 chars) or SHA-256 (64 chars) hex digest.
 */
export function isValidFileHash(hash?: string | null): boolean {
  if (!hash) return false;
  return /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{64}$/.test(hash.trim());
}

/**
 * Validates standard MIME type format.
 */
export function isValidMimeType(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  return /^[a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+$/.test(mimeType.trim());
}

/**
 * Checks whether a MIME type represents a PDF document.
 */
export function isPdfMimeType(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  return mimeType.toLowerCase().trim() === 'application/pdf';
}
