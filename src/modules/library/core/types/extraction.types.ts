import type { AttachmentExtractionStatus as PrismaExtractionStatus } from '@prisma/client';
import type {
  BibliographicReference,
  DocumentSection,
  DocumentFigure,
  DocumentTable,
  DocumentFormula,
  AcademicCreator,
  ItemMetadata,
} from './bibliographic.types';

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
  storageKey?: string;
  linkMode?: LinkMode;
  attachmentType?: AttachmentType;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}

export const AnnotationType = {
  highlight: 'highlight',
  underline: 'underline',
  strike: 'strike',
  note: 'note',
  rect: 'rect',
  text: 'text',
  image: 'image',
  ink: 'ink',
} as const;

export type AnnotationType =
  (typeof AnnotationType)[keyof typeof AnnotationType];

export interface AnnotationEntity {
  id: string;
  attachmentId: string;
  type: AnnotationType;
  pageIndex: number;
  annotationSortIndex?: string | null;
  color: string;
  quoteText?: string | null;
  comment?: string | null;
  tags: string[];
  rectCoords?: unknown;
  authorId: string;
  version: number;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAnnotationData {
  attachmentId: string;
  type?: AnnotationType;
  pageIndex: number;
  y?: number;
  x?: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  annotationSortIndex?: string;
  authorId: string;
}

export interface UpdateAnnotationData {
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  annotationSortIndex?: string;
}

export interface UpsertAnnotationItem {
  id?: string;
  type?: AnnotationType;
  pageIndex: number;
  y?: number;
  x?: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  expectedVersion?: number;
}

export interface BatchAnnotationsData {
  upserts: UpsertAnnotationItem[];
  deletes: string[];
}

export interface BatchAnnotationsResult {
  created: AnnotationEntity[];
  updated: AnnotationEntity[];
  deleted: string[];
}

export interface ExtractedPdfMetadata {
  doi?: string;
  isbn?: string;
  arxivId?: string;
  primaryCategory?: string;
  pmid?: string;
  title?: string;
  authors?: string[];
  creators?: AcademicCreator[];
  year?: number;
  publicationDate?: string;
  publisher?: string;
  repository?: string;
  numberOfPages?: number;
  abstract?: string;
  abstractParagraphs?: string[];
  abstractSections?: Array<{ heading?: string; text: string }>;
  keywords?: string[];
  notes?: Array<{ content: string; type?: string }>;
  journal?: string;
  publicationTitle?: string;
  bookTitle?: string;
  conferenceName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  place?: string;
  issn?: string;
  creationDate?: string;
  rawText?: string;
  rawTei?: string;
  referenceCount?: number;
  citationCount?: number;
  isSelfSufficient?: boolean;
  qualityScore?: number;
  engineUsed?: string;
}

export interface OcrPageProvenance {
  pageIndex: number;
  confidence: number;
  orientationAngle: number;
  skewAngle: number;
  preprocessed: boolean;
  textLength: number;
  lineCount: number;
  wordCount: number;
  executionTimeMs: number;
}

export interface OcrProvenanceData {
  totalOcrPages: number;
  avgConfidence: number;
  executionTimeMs: number;
  pages: OcrPageProvenance[];
}

export interface ExtractedPdfDocument {
  metadata: ExtractedPdfMetadata;
  pages: Array<{
    pageIndex: number;
    textContent: string;
    charOffset: number;
  }>;
  references?: BibliographicReference[];
  sections?: DocumentSection[];
  figures?: DocumentFigure[];
  tables?: DocumentTable[];
  formulas?: DocumentFormula[];
  ocrProvenance?: OcrProvenanceData;
  searchablePdfBuffer?: Buffer;
  fullText?: string;
}

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
    [key: string]: unknown;
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

