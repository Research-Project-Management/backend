import type {
  BibliographicReference,
  DocumentSection,
  DocumentFigure,
  DocumentTable,
  DocumentFormula,
  AcademicCreator,
} from './bibliographic.types';
import type { ItemMetadata } from './bibliographic.types';

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
  extractionStatus?: unknown;
  extractionAttempts?: number;
  extractionStartedAt?: Date | null;
  extractionCompletedAt?: Date | null;
  extractionLastError?: string | null;
  revisions?: AttachmentRevisionEntity[];
}

export interface CreateAttachmentInput {
  userId?: string;
  itemId: string;
  filename: string;
  url: string;
  size?: number | bigint;
  mimeType?: string;
  linkMode?: LinkMode;
  attachmentType?: AttachmentType;
  fileHash?: string;
  fileId?: string;
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
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  annotationSortIndex?: string;
}

export interface UpdateAnnotationData {
  color?: string;
  comment?: string;
  tags?: string[];
  quoteText?: string;
  rectCoords?: unknown;
  annotationSortIndex?: string;
}

export interface BatchAnnotationsData {
  created?: CreateAnnotationData[];
  updated?: Array<{
    id: string;
    expectedVersion: number;
    data: UpdateAnnotationData;
  }>;
  deleted?: Array<{ id: string; expectedVersion?: number }>;
}

export interface BatchAnnotationsResult {
  created: AnnotationEntity[];
  updated: AnnotationEntity[];
  deleted: string[];
  conflicts: Array<{ id: string; reason: string }>;
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

export interface QualityScoreBreakdown {
  titleScore: number;
  authorScore: number;
  identifierScore: number;
  yearScore: number;
  venueScore: number;
  totalScore: number;
}

export type ExtractionEngineKind =
  | 'XMP_BINARY'
  | 'ACADEMIC_REGEX'
  | 'LAYOUT_HEURISTIC'
  | 'MEXTRACT_SLM'
  | 'HYBRID';

export interface TrustedExtractionResult {
  metadata: ItemMetadata;
  quality: QualityScoreBreakdown;
  isAuthoritative: boolean;
  provenance: {
    extractedAt: string;
    engineUsed: ExtractionEngineKind;
    executionTimeMs: number;
    qualityBreakdown: QualityScoreBreakdown;
    rawMatches?: Record<string, unknown>;
  };
}
