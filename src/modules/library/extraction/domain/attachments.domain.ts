import { createHash } from 'crypto';
import type { getDocumentProxy } from 'unpdf';
import { ItemMetadata } from '@/modules/library/core';
import {
  AttachmentType,
  AttachmentInvariantError,
  ExtractionEngineKind,
} from '@/modules/library/extraction/types/extraction.types';

/**
 * Computes SHA-256 hex digest of a file buffer.
 */
export function calculateFileChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
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

export type ExtractedMetadata = ItemMetadata;

export interface FieldExtractionProvenance {
  source: string;
  confidence: number;
}

/**
 * Context Object for the 4-Tier PDF Metadata Extraction Chain of Responsibility.
 */
export class PdfExtractionTierContext {
  public readonly merged: ExtractedMetadata;
  public readonly provenance: Record<string, FieldExtractionProvenance> = {};
  public readonly tiersExecuted: string[] = [];
  public readonly rawMatches: Record<string, unknown> = {};
  public readonly buffer?: Buffer;
  public pageText = '';
  public sharedDoc?: Awaited<ReturnType<typeof getDocumentProxy>>;
  public engineUsed: ExtractionEngineKind = 'ACADEMIC_REGEX';
  public xmpYear?: number;
  public xmpFound = false;

  constructor(init?: {
    buffer?: Buffer;
    sharedDoc?: Awaited<ReturnType<typeof getDocumentProxy>>;
    initialMetadata?: ExtractedMetadata;
  }) {
    this.buffer = init?.buffer;
    this.sharedDoc = init?.sharedDoc;
    this.merged = init?.initialMetadata ? { ...init.initialMetadata } : {};
  }

  public recordTierExecuted(tierName: string): void {
    if (tierName && !this.tiersExecuted.includes(tierName)) {
      this.tiersExecuted.push(tierName);
    }
  }

  public mergeFieldIfEmpty<K extends keyof ExtractedMetadata>(
    field: K,
    value: ExtractedMetadata[K] | undefined,
    source: string,
    confidence: number,
    options?: {
      allowOverwritePredicate?: (
        currentVal: ExtractedMetadata[K] | undefined,
      ) => boolean;
      rejectValuePredicate?: (
        candidateVal: NonNullable<ExtractedMetadata[K]>,
      ) => boolean;
    },
  ): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string' && value.trim().length === 0) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (options?.rejectValuePredicate?.(value)) {
      return false;
    }

    const current = this.merged[field];
    const isCurrentEmpty =
      current === undefined ||
      current === null ||
      (typeof current === 'string' && current.trim().length === 0) ||
      (Array.isArray(current) && current.length === 0) ||
      Boolean(options?.allowOverwritePredicate?.(current));

    if (!isCurrentEmpty) {
      return false;
    }

    this.merged[field] = value;
    this.provenance[String(field)] = { source, confidence };
    this.recordTierExecuted(source);
    return true;
  }

  public mergeTierFields(
    fields: Partial<ExtractedMetadata>,
    source: string,
    confidence: number,
    options?: {
      isBogusTitle?: (t?: string) => boolean;
    },
  ): boolean {
    let anyMerged = false;
    const keys = Object.keys(fields) as Array<keyof ExtractedMetadata>;

    for (const key of keys) {
      const val = fields[key];
      if (key === 'title') {
        const didMerge = this.mergeFieldIfEmpty(
          'title',
          val as string | undefined,
          source,
          confidence,
          {
            allowOverwritePredicate: (cur) =>
              cur === 'Uploaded Document' ||
              Boolean(options?.isBogusTitle?.(cur)),
            rejectValuePredicate: (cand) =>
              Boolean(options?.isBogusTitle?.(cand)),
          },
        );
        if (didMerge) anyMerged = true;
      } else {
        const didMerge = this.mergeFieldIfEmpty(key, val, source, confidence);
        if (didMerge) anyMerged = true;
      }
    }

    return anyMerged;
  }
}

export interface IPdfExtractionTier {
  readonly tierName: string;
  executeTier(ctx: PdfExtractionTierContext): Promise<void>;
}

export async function runPdfExtractionTierChain(
  ctx: PdfExtractionTierContext,
  tiers: readonly IPdfExtractionTier[],
): Promise<void> {
  for (const tier of tiers) {
    await tier.executeTier(ctx);
  }
}
