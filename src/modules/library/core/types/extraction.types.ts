import type { AttachmentExtractionStatus as PrismaExtractionStatus } from '@prisma/client';
import type { BibliographicReference, DocumentSection, DocumentFigure, DocumentTable, DocumentFormula, ItemCreator, ItemMetadata } from './bibliographic.types';

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
  itemId?: string | null;
  imageFileId?: string | null;
  type: AnnotationType;
  pageIndex: number;
  pageLabel?: string | null;
  annotationSortIndex?: string | null;
  color: string;
  quoteText?: string | null;
  text?: string | null;
  comment?: string | null;
  tags: string[];
  rectCoords?: unknown;
  rects?: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width?: number;
    height?: number;
  }>;
  authorId: string;
  version: number;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAnnotationData {
  id?: string;
  attachmentId: string;
  itemId?: string;
  imageFileId?: string | null;
  type?: AnnotationType;
  pageIndex: number;
  pageLabel?: string;
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
  type?: AnnotationType;
  pageIndex?: number;
  pageLabel?: string;
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  imageFileId?: string | null;
  y?: number;
  x?: number;
  annotationSortIndex?: string;
}

export interface UpsertAnnotationItem {
  id?: string;
  itemId?: string;
  imageFileId?: string | null;
  type?: AnnotationType;
  pageIndex: number;
  pageLabel?: string;
  y?: number;
  x?: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  annotationSortIndex?: string;
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
  creators?: ItemCreator[];
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
  referenceCount?: number;
  citationCount?: number;
  isSelfSufficient?: boolean;
  qualityScore?: number;
  engineUsed?: string;
}

export interface ExtractedPdfDocument {
  metadata: ExtractedPdfMetadata;
  pages: Array<{
    pageIndex: number;
    pageNumber?: number;
    textContent: string;
    text?: string;
    charOffset: number;
  }>;
  references?: BibliographicReference[];
  sections?: DocumentSection[];
  figures?: DocumentFigure[];
  tables?: DocumentTable[];
  formulas?: DocumentFormula[];
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
  | 'XMP'
  | 'REGEX'
  | 'LAYOUT'
  | 'HYBRID';

/**
 * Full provenance audit for local-first trusted extraction.
 */
export interface PdfMetadataExtractionProvenance {
  extractedAt: string;
  engineUsed: ExtractionEngineKind;
  executionTimeMs: number;
  qualityBreakdown: QualityScoreBreakdown;
  fieldProvenance?: Record<string, { source: string; confidence: number }>;
  rawMatches?: {
    xmpFound?: boolean;
    detectedDoi?: string;
    detectedArxivId?: string;
    detectedPmid?: string;
    detectedIsbn?: string;
    matchedPublisherBanner?: string;
    maxFontSize?: number;
    [key: string]: unknown;
  };
}

/**
 * Canonical result contract returned by the TrustedExtractor port.
 */
export interface PdfMetadataExtractionResult {
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

  provenance: PdfMetadataExtractionProvenance;
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

export interface IPdfMetadataExtractorPort {
  extract(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<PdfMetadataExtractionResult>;
}

export type RectCoords = [number, number, number, number];

export interface ClaimedAttachmentRecord {
  id: string;
  itemId: string;
  fileId?: string | null;
  url?: string;
  filename?: string;
  metadata?: unknown;
  item?: {
    id?: string;
    userId?: string;
    projectId?: string | null;
    title?: string;
    doi?: string | null;
    arxivId?: string | null;
    abstract?: string | null;
    year?: number | null;
    metadata?: unknown;
    contributors?: unknown[];
    itemTags?: unknown[];
    notesList?: unknown[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export interface FullTextOffloadDocument {
  references?: unknown[];
  sections?: unknown[];
  figures?: unknown[];
  tables?: unknown[];
  formulas?: unknown[];
  fullText?: string;
  pages?: Array<{
    pageIndex?: number;
    pageNumber?: number;
    textContent?: string;
    text?: string;
  }>;
  metadata?: {
    rawText?: string;
    keywords?: string[];
    notes?: Array<{ content: string; type?: string }>;
    title?: string;
    doi?: string;
    arxivId?: string;
    abstract?: string;
    year?: number;
    numberOfPages?: number;
    publicationTitle?: string;
    journal?: string;
    proceedingsTitle?: string;
    conferenceName?: string;
    bookTitle?: string;
    isbn?: string;
    issn?: string;
    pmid?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    publisher?: string;
    place?: string;
    publicationDate?: string;
    primaryCategory?: string;
    authors?: string[];
    creators?: Array<{
      creatorType?: string;
      fullName?: string;
      name?: string;
      firstName?: string;
      lastName?: string;
      fieldMode?: number;
    }>;
  };
}

export interface FullTextOffloadResult {
  text?: string;
  sections?: unknown[];
  figures?: unknown[];
  tables?: unknown[];
  formulas?: unknown[];
  references?: unknown[];
  markdown?: string;
  pageCount?: number;
  qualityScore?: number;
  engineUsed?: string;
}

