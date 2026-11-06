import type { Prisma } from '@prisma/client';

export * from '@/modules/library/core/types/extraction.types';

export interface ExtractionSyncAttachmentInput {
  id: string;
  itemId: string;
  attachmentType?: string | null;
  item?:
    | (Record<string, unknown> & {
        id?: string;
        userId?: string;
        projectId?: string | null;
        title?: string;
        doi?: string | null;
        arxivId?: string | null;
        pmid?: string | null;
        pmcid?: string | null;
        isbn?: string | null;
        issn?: string | null;
        abstract?: string | null;
        year?: number | null;
        publicationTitle?: string | null;
        itemType?: string | null;
        metadata?: unknown;
      })
    | null;
  [key: string]: unknown;
}

export interface ExtractionSyncDocumentInput {
  references?: unknown[];
  metadata?: {
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
    pmcid?: string;
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
    fieldProvenance?: Record<
      string,
      { source?: string; confidence?: number; extractedAt?: string }
    >;
  };
}

export interface ExtractedMetadataSyncPlan {
  itemPatch: Prisma.ItemUpdateInput;
  metaPatch: Record<string, unknown>;
  extractedIdentifiers: Array<{
    type: string;
    value: string;
    canonicalUri: string;
  }>;
  creatorsToSync: Array<{
    creatorType?: string;
    fullName?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    fieldMode?: number;
  }>;
  primaryRole: string;
  tagsToSync: string[];
  notesToSync: Array<{ content: string; type?: string }>;
}

export interface FieldExtractionProvenance {
  source: string;
  confidence: number;
}

export interface ImportAnnotationsResult {
  imported: number;
  importedCount: number;
  totalFound: number;
  pagesScanned: number;
}

export interface ExtractedReferenceCandidate {
  title?: string;
  doi?: string;
  arxivId?: string;
  authors?: string[];
  year?: number | string;
  rawText?: string;
}

export interface ReferenceMatchResult {
  sourceItemId: string;
  targetItemId: string;
  matchType: 'DOI' | 'ARXIV' | 'TITLE_AUTHOR_YEAR' | 'TITLE';
  matchedTitle?: string;
  matchedDoi?: string;
}

export interface ScopePaperRecord {
  id: string;
  title?: string | null;
  doi?: string | null;
  arxivId?: string | null;
  year?: number | null;
  metadata?: unknown;
  contributors?: Array<{
    lastName?: string | null;
    fullName?: string | null;
  }>;
}

export interface SnapshotTemplateParams {
  canonicalUrl: string;
  capturedAtIso: string;
  formattedDate: string;
  title: string;
  byline?: string;
  siteName: string;
  sanitizedBody: string;
}
