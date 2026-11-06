import type { getDocumentProxy } from 'unpdf';
import {
  ItemMetadata,
  isInstitutionName,
  isNoiseAuthorName,
  isValidIsbnChecksum,
  AttachmentInvariantError,
} from '@/modules/library/core';
import {
  AttachmentType,
  ExtractionEngineKind,
  QualityScoreBreakdown,
} from '@/modules/library/core/types/extraction.types';

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

type ExtractedMetadata = ItemMetadata;

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
  public pageTexts: string[] = [];
  public runningHeaderFooters: Set<string> = new Set<string>();
  public sharedDoc?: Awaited<ReturnType<typeof getDocumentProxy>>;
  public engineUsed: ExtractionEngineKind = 'REGEX';
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

export function isBogusTitle(t?: string): boolean {
  if (!t) return true;
  const lower = t.toLowerCase().trim();
  return (
    lower.startsWith('microsoft') ||
    lower.startsWith('untitled') ||
    lower.startsWith('document') ||
    lower.startsWith('arxiv:') ||
    lower === 'technical report' ||
    /^arxiv\s*:\s*[a-z0-9\-./]+/i.test(lower) ||
    /^10\.\d{4,9}\/\S+$/i.test(lower) ||
    /^(?:dvips(?:\(k\))?|pdftex|xelatex|lualatex|latex2e|tex\s+output| radical eye software)\b/i.test(
      lower,
    ) ||
    /\.(docx?|pdf|tex|txt|ps|eps|dvi|ppt|pptx|rtf|html?)$/i.test(lower) ||
    /^[a-z0-9_.-]+\s+\d+\.\.\d+$/i.test(lower) ||
    lower.length < 5
  );
}

export async function runPdfExtractionTierChain(
  ctx: PdfExtractionTierContext,
  tiers: readonly IPdfExtractionTier[],
): Promise<void> {
  for (const tier of tiers) {
    await tier.executeTier(ctx);
  }
}

interface EvaluationResult {
  breakdown: QualityScoreBreakdown;
  isSelfSufficient: boolean;
  missingFields: string[];
}

/**
 * Deterministic Decision Gate evaluating whether extracted local metadata
 * is sufficiently authoritative to bypass external APIs and heavy ML sidecars.
 */
export class MetadataQualityGate {
  public static readonly SELF_SUFFICIENCY_THRESHOLD = 0.85;

  private static readonly WEIGHT_TITLE = 0.3;
  private static readonly WEIGHT_AUTHOR = 0.25;
  private static readonly WEIGHT_IDENTIFIER = 0.2;
  private static readonly WEIGHT_YEAR = 0.15;
  private static readonly WEIGHT_VENUE = 0.1;

  private static readonly GARBAGE_TITLE_REGEX =
    /^(untitled|document|microsoft word|manuscript|proceedings of the|submitted to|accepted at|journal pre-proof|accepted manuscript|author guidelines|camera-ready|supplementary material|powerpoint presentation|latex template|https?:\/\/|\d{4}\.\d{4,5})/i;

  private static evaluateTitle(title?: string): number {
    if (!title || typeof title !== 'string') return 0.0;
    const clean = title.trim();
    if (clean.length < 8) return 0.0;
    if (clean.endsWith('.pdf') || clean.endsWith('.eps')) return 0.0;
    if (this.GARBAGE_TITLE_REGEX.test(clean)) return 0.0;
    if (clean.length >= 15) return 1.0;
    return 0.7;
  }

  private static evaluateAuthors(
    authors?: string[],
    creators?: Array<
      | { fullName?: string | null; name?: string | null }
      | string
      | Record<string, unknown>
    >,
  ): number {
    const list =
      authors && authors.length > 0
        ? authors
        : creators && creators.length > 0
          ? creators.map((c) => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object') {
                const rec = c as Record<string, unknown>;
                return (
                  (typeof rec.fullName === 'string' ? rec.fullName : null) ||
                  (typeof rec.name === 'string' ? rec.name : null) ||
                  undefined
                );
              }
              return undefined;
            })
          : [];

    if (list.length === 0) return 0.0;

    const validPersons = list.filter((name) => {
      if (!name || typeof name !== 'string') return false;
      const t = name.trim();
      if (t.length < 2 || /^\d+$/.test(t)) return false;
      if (
        /^(admin|administrator|user|owner|author|default|root|guest|unknown|test)$/i.test(
          t,
        )
      ) {
        return false;
      }
      if (isInstitutionName(t) || isNoiseAuthorName(t)) return false;
      return true;
    });

    if (validPersons.length >= 1) return 1.0;
    return 0.3;
  }

  private static evaluateIdentifier(
    doi?: string,
    arxivId?: string,
    pmid?: string,
    isbn?: string,
  ): number {
    if (doi && /^10\.\d{4,9}\/\S+$/i.test(doi)) return 1.0;
    if (arxivId && /^\d{4}\.\d{4,5}/.test(arxivId)) return 1.0;
    if (pmid && /^\d{7,9}$/.test(pmid)) return 1.0;
    if (isbn && isValidIsbnChecksum(isbn)) return 1.0;
    return 0.0;
  }

  private static evaluateYear(year?: number | null): number {
    if (!year || typeof year !== 'number') return 0.0;
    const currentYear = new Date().getFullYear();
    if (year >= 1900 && year <= currentYear + 2) {
      return 1.0;
    }
    return 0.0;
  }

  private static evaluateVenue(
    journal?: string,
    publisher?: string,
    conferenceName?: string,
  ): number {
    if (
      (journal && journal.trim().length > 2) ||
      (conferenceName && conferenceName.trim().length > 2)
    ) {
      return 1.0;
    }
    if (publisher && publisher.trim().length > 2) {
      return 0.8;
    }
    return 0.0;
  }

  public static evaluate(metadata: ItemMetadata): EvaluationResult {
    const dimensions = [
      {
        key: 'titleScore' as const,
        weight: this.WEIGHT_TITLE,
        minValid: 0.7,
        missingField: 'title',
        score: this.evaluateTitle(metadata.title),
      },
      {
        key: 'authorScore' as const,
        weight: this.WEIGHT_AUTHOR,
        minValid: 0.5,
        missingField: 'authors',
        score: this.evaluateAuthors(metadata.authors, metadata.creators),
      },
      {
        key: 'identifierScore' as const,
        weight: this.WEIGHT_IDENTIFIER,
        minValid: 0.01,
        missingField: 'doi/arxivId',
        score: this.evaluateIdentifier(
          metadata.doi,
          metadata.arxivId,
          metadata.pmid,
          metadata.isbn,
        ),
      },
      {
        key: 'yearScore' as const,
        weight: this.WEIGHT_YEAR,
        minValid: 0.01,
        missingField: 'year',
        score: this.evaluateYear(metadata.year),
      },
      {
        key: 'venueScore' as const,
        weight: this.WEIGHT_VENUE,
        minValid: 0.01,
        missingField: 'journal/publisher',
        score: this.evaluateVenue(
          metadata.journal || metadata.publicationTitle,
          metadata.publisher,
          metadata.conferenceName,
        ),
      },
    ];

    let totalRaw = 0;
    const missingFields: string[] = [];
    const scoresByKey = {} as Record<
      (typeof dimensions)[number]['key'],
      number
    >;

    for (const d of dimensions) {
      totalRaw += d.weight * d.score;
      scoresByKey[d.key] = d.score;
      if (d.score < d.minValid) {
        missingFields.push(d.missingField);
      }
    }

    const totalScore = Math.round(totalRaw * 100) / 100;

    return {
      breakdown: {
        ...scoresByKey,
        totalScore,
      },
      isSelfSufficient: totalScore >= this.SELF_SUFFICIENCY_THRESHOLD,
      missingFields,
    };
  }
}
