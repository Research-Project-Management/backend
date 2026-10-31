import { Prisma } from '@prisma/client';

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
  bibliography: string;
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

/** Maximum number of items exported in a single request. */
export const EXPORT_MAX_ITEMS = 1000;
/** Cursor-page size used when fetching from the DB. */
export const EXPORT_CHUNK_SIZE = 200;

export type ExportItemRecord = Prisma.ItemGetPayload<{
  include: {
    contributors: { orderBy: { orderIndex: 'asc' } };
    itemTags: { include: { tag: true } };
    notesList: { where: { deletedAt: null } };
    identifiers: true;
  };
}>;

export type ExportFormatType =
  | 'bibtex'
  | 'ris'
  | 'csl-json'
  | 'csl_json'
  | 'csv'
  | 'markdown';

export interface BurnableAnnotation {
  pageIndex: number;
  type?: string;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    rects?: Array<{ x: number; y: number; width: number; height: number }>;
  };
}

export interface CsvExportItem {
  id: string;
  title?: string | null;
  authors?: string[];
  year?: number | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  doi?: string | null;
  itemType?: string | null;
  citationKey?: string | null;
  url?: string | null;
}

export interface ExportResult {
  format: ExportFormatType;
  filename: string;
  mimeType: string;
  content: string;
  itemCount: number;
  truncated?: boolean;
}

/**
 * Citation Style Language (CSL) JSON Data Schema v1.0.2
 * Conforming to https://github.com/citation-style-language/schema
 */

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  short?: string;
  'dropping-particle'?: string;
  'non-dropping-particle'?: string;
  suffix?: string;
}

export interface CslDate {
  'date-parts'?: Array<Array<number | string>>;
  raw?: string;
  literal?: string;
  circa?: boolean | string | number;
  season?: number | string;
}

export interface CslItemData {
  id: string;
  type: string;
  title: string;
  'title-short'?: string;
  author?: CslName[];
  editor?: CslName[];
  translator?: CslName[];
  'container-author'?: CslName[];
  'collection-editor'?: CslName[];
  'original-author'?: CslName[];
  composer?: CslName[];
  director?: CslName[];
  interviewer?: CslName[];
  recipient?: CslName[];
  'reviewed-author'?: CslName[];
  illustrator?: CslName[];
  contributor?: CslName[];

  // Container & Publishing Information
  'container-title'?: string;
  'container-title-short'?: string;
  'collection-title'?: string;
  'collection-number'?: string | number;
  'event-title'?: string;
  event?: string;
  publisher?: string;
  'publisher-place'?: string;
  authority?: string;
  jurisdiction?: string;

  // Dates
  issued?: CslDate;
  accessed?: CslDate;
  submitted?: CslDate;

  // Locators & Numbers
  number?: string | number;
  volume?: string | number;
  issue?: string | number;
  'number-of-volumes'?: string | number;
  edition?: string | number;
  page?: string;
  'page-first'?: string;
  'number-of-pages'?: string | number;
  section?: string;

  // Identifiers
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  PMID?: string;
  PMCID?: string;
  URL?: string;
  archive?: string;
  'archive-location'?: string;
  archive_location?: string;
  'call-number'?: string;

  // Classification & Content
  abstract?: string;
  keyword?: string;
  genre?: string;
  note?: string;
  version?: string;
  language?: string;
  status?: string;
  [key: string]: unknown;
}
