import { ItemMetadata } from '../../shared-kernel';

/**
 * Breakdown of individual field quality scores evaluating extraction reliability.
 */
export interface QualityScoreBreakdown {
  titleScore: number; // Weight: 0.30
  authorScore: number; // Weight: 0.25
  identifierScore: number; // Weight: 0.20 (DOI / arXiv ID / PMID / ISBN)
  yearScore: number; // Weight: 0.15
  venueScore: number; // Weight: 0.10
  totalScore: number; // Normalized total score S ∈ [0.0, 1.0]
}

/**
 * Extraction engine tags indicating which local tier produced the metadata.
 */
export type ExtractionEngineKind =
  | 'XMP_BINARY'
  | 'ACADEMIC_REGEX'
  | 'LAYOUT_HEURISTIC'
  | 'MEXTRACT_SLM'
  | 'HYBRID';

/**
 * Full provenance audit for local-first trusted extraction.
 */
export interface TrustedExtractionProvenance {
  extractedAt: string;
  engineUsed: ExtractionEngineKind;
  executionTimeMs: number;
  qualityBreakdown: QualityScoreBreakdown;
  rawMatches?: {
    xmpFound?: boolean;
    detectedDoi?: string;
    detectedArxivId?: string;
    detectedPmid?: string;
    detectedIsbn?: string;
    matchedPublisherBanner?: string;
    maxFontSize?: number;
    mextract?: {
      engine: string;
      confidence: number;
      durationMs: number;
    };
    [key: string]: any;
  };
}

/**
 * Canonical result contract returned by the TrustedExtractor port.
 */
export interface TrustedExtractionResult {
  metadata: ItemMetadata;
  quality: QualityScoreBreakdown;

  /**
   * CRITICAL DECISION GATE FLAG:
   * When true (totalScore >= 0.85), this candidate possesses verified, authoritative
   * metadata directly from the document itself. Downstream stages MUST bypass
   * heavy external API calls (CrossRef, OpenAlex, Semantic Scholar) and slow network round-trips.
   */
  isSelfSufficient: boolean;
  missingFields?: string[];

  provenance: TrustedExtractionProvenance;
}

/**
 * Raw XMP XML packet parsing representation.
 */
export interface RawXmpMetadata {
  doi?: string;
  title?: string;
  authors?: string[];
  publicationDate?: string;
  year?: number;
  publisher?: string;
  journal?: string;
  description?: string;
  keywords?: string[];
  rawPacket?: string;
}

export const TRUSTED_EXTRACTOR_PORT = Symbol('TRUSTED_EXTRACTOR_PORT');

export interface ITrustedExtractorPort {
  extract(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult>;
}
