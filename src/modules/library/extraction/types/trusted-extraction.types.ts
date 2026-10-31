import type {
  QualityScoreBreakdown,
  ExtractionEngineKind,
  TrustedExtractionProvenance,
  TrustedExtractionResult,
} from '@/modules/library/core/types/extraction.types';

export type {
  QualityScoreBreakdown,
  ExtractionEngineKind,
  TrustedExtractionProvenance,
  TrustedExtractionResult,
};

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

export interface ITrustedExtractorPort {
  extract(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult>;
}
