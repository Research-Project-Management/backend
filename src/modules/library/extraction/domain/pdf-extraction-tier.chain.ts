import { ItemMetadata } from '@/modules/library/core';
import { ExtractionEngineKind } from '@/modules/library/extraction/types/trusted-extraction.types';
import type { getDocumentProxy } from 'unpdf';

export type ExtractedMetadata = ItemMetadata;

export interface FieldExtractionProvenance {
  source: string;
  confidence: number;
}

/**
 * Context Object for the 4-Tier PDF Metadata Extraction Chain of Responsibility.
 *
 * Encapsulates the mutable `merged` metadata state, per-field provenance tracking,
 * `tiersExecuted` trace, and `mergeFieldIfEmpty` / `mergeTierFields` helpers so
 * concrete extraction tiers (`XmpParser`, `AcademicRegexCatalog`, `LayoutHeuristicExtractor`,
 * `MeXtractExtractor`) do not duplicate `if (!merged.field && tier.field)` boilerplate.
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

/**
 * GoF Chain of Responsibility — `IPdfExtractionTier`
 */
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
