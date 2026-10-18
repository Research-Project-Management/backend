export type CitationStyleId =
  | 'apa'
  | 'apa-7th'
  | 'ieee'
  | 'nature'
  | 'harvard'
  | 'chicago'
  | 'chicago-author-date'
  | 'mla'
  | 'mla-9th'
  | 'vancouver'
  | 'bibtex'
  | 'ris'
  | (string & {});

export interface CitationCreator {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  fullName?: string | null;
  role?: string | null;
  creatorType?: string | null;
}

export interface CitationItemInput {
  id?: string;
  itemType: string;
  title: string;
  creators?: CitationCreator[];
  contributors?: CitationCreator[];
  authors?: string[];
  publicationTitle?: string | null;
  journal?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  year?: number | null;
  date?: string | null;
  doi?: string | null;
  url?: string | null;
  citationKey?: string | null;
  city?: string | null;
  place?: string | null;
  edition?: string | null;
  series?: string | null;
  isbn?: string | null;
  issn?: string | null;
  arxivId?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  extra?: string | null;
  accessedAt?: Date | string | null;
  accessDate?: Date | string | null;
  publicationDate?: string | null;
  bookTitle?: string | null;
  proceedingsTitle?: string | null;
  conferenceName?: string | null;
  thesisType?: string | null;
  reportType?: string | null;
  versionNumber?: string | null;
  abstract?: string | null;
  extraFields?: Record<string, unknown> | null;
  metadata?: unknown;
  /** Last modification timestamp; used to invalidate the CSL engine render cache. */
  updatedAt?: Date | string | null;
  /** Optional optimistic-lock / revision number; also part of the render cache key. */
  version?: number | string | null;
  [key: string]: unknown;
}

export interface FormattedCitationResult {
  styleId?: CitationStyleId;
  style?: string;
  itemId?: string;
  formattedText?: string;
  inText?: string;
  bibliography?: string;
  bibliographyHtml?: string;
  source?: 'publisher' | 'csl-engine' | (string & {});
}

export interface ReferenceData {
  doi?: string;
  title: string;
  authors?: string[];
  creators?: Array<{
    creatorType?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  }>;
  year?: number | string;
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  url?: string;
  openAccessPdfUrl?: string;
  abstract?: string;
  citationCount?: number | string | null;
  keywords?: string[];
  tags?: string[];
  type?: string;
  itemType?: string;
  containerTitle?: string;
  score?: number;
  extraFields?: Record<string, unknown>;
  provenance?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface CatalogItemCreator {
  creatorType?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}

export interface CatalogItemRecord {
  id: string;
  title: string;
  itemType?: string | null;
  doi?: string | null;
  url?: string | null;
  citationKey?: string | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  year?: number | null;
  contributors?: CatalogItemCreator[] | null;
  [key: string]: unknown;
}
