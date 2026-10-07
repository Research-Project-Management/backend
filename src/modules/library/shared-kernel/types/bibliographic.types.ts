/**
 * Canonical Bibliographic Types & Constants for Library Shared Kernel.
 * Aligned with Zotero v42 schema and CSL v1.0.2 standards.
 */

// ── Creator & Contributor Roles ──────────────────────────────────────────────
export type CreatorType =
  | 'author'
  | 'editor'
  | 'translator'
  | 'contributor'
  | 'advisor'
  | 'reviewer'
  | 'seriesEditor'
  | 'bookAuthor'
  | 'reviewedAuthor'
  | 'inventor'
  | 'attorneyAgent'
  | 'director'
  | 'producer'
  | 'scriptwriter'
  | 'presenter'
  | 'counsel'
  | 'interviewee'
  | 'interviewer'
  | 'cartographer'
  | 'programmer'
  | 'artist'
  | 'recipient'
  | 'performer'
  | 'composer'
  | 'wordsBy'
  | 'guest'
  | 'castMember'
  | 'podcaster'
  | 'sponsor'
  | 'cosponsor'
  | 'commenter'
  | (string & {});

export interface CreatorCredit {
  id?: string | null;
  orderIndex: number;
  creatorType: CreatorType;
  fieldMode?: number;
  firstName?: string | null;
  lastName?: string | null;
  fullName: string;
  shortName?: string | null;
}

export interface CreatorCreditInput {
  name?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  creatorType?: CreatorType;
  fieldMode?: number;
  shortName?: string | null;
  orderIndex?: number;
}

export type CreatorInput = CreatorCreditInput;

export interface ParsedCreator {
  orderIndex: number;
  creatorType: CreatorType;
  fieldMode?: number;
  firstName: string;
  lastName: string;
  fullName: string;
  shortName?: string;
}

// ── Persistent Identifiers ───────────────────────────────────────────────────
export type IdentifierScheme =
  'doi' | 'arxiv' | 'pmid' | 'isbn' | 'issn' | 'url' | 'urn' | (string & {});

// ── Tag Input ────────────────────────────────────────────────────────────────
export type TagObjectInput = {
  tag?: string;
  name?: string;
  type?: number | string;
};
export type TagInput = string | TagObjectInput;

/**
 * Maps itemType → its primary venue/container field name for display.
 * e.g. journalArticle → 'publicationTitle', bookSection → 'bookTitle'.
 *
 * Distinct from schema.constants.ts BASE_FIELD_MAPPINGS which is the
 * nested Zotero base-field → type-specific-field crosswalk (different shape).
 */
export const VENUE_FIELD_MAP: Record<string, string> = {
  publicationTitle: 'publicationTitle',
  journalArticle: 'publicationTitle',
  proceedingsTitle: 'proceedingsTitle',
  conferencePaper: 'proceedingsTitle',
  bookTitle: 'bookTitle',
  bookSection: 'bookTitle',
  dictionaryTitle: 'dictionaryTitle',
  encyclopediaTitle: 'encyclopediaTitle',
  seriesTitle: 'seriesTitle',
  seriesText: 'seriesText',
  websiteTitle: 'websiteTitle',
  blogTitle: 'blogTitle',
  forumTitle: 'forumTitle',
  programTitle: 'programTitle',
  episodeNumber: 'episodeNumber',
  audioRecordingFormat: 'audioRecordingFormat',
  videoRecordingFormat: 'videoRecordingFormat',
};

export const ITEM_COLUMN_METADATA_FIELDS = [
  'title',
  'itemType',
  'doi',
  'url',
  'abstract',
  'publicationTitle',
  'volume',
  'issue',
  'pages',
  'date',
  'year',
  'publisher',
  'place',
  'isbn',
  'issn',
  'language',
  'edition',
  'series',
  'seriesNumber',
  'accessDate',
  'archive',
  'archiveLocation',
  'callNumber',
  'rights',
  'section',
  'citationKey',
] as const;

export interface CreateItemData {
  title: string;
  authors?: string[];
  year?: number | null;
  doi?: string;
  abstract?: string;
  /** Zotero alias for abstract. Either field may be provided; they are kept
   *  in sync throughout the stack. Stored in the single DB `abstract` column. */
  abstractNote?: string;
  itemType?: string;
  editors?: string[];
  journal?: string;
  publicationTitle?: string;
  publicationDate?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  issn?: string;
  isbn?: string;
  pmid?: string;
  pmcid?: string;
  arxivId?: string;
  primaryCategory?: string;
  url?: string;
  accessDate?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  rights?: string;
  language?: string;
  edition?: string;
  shortTitle?: string;
  citationKey?: string;
  extra?: string;
  tags?: string[];
  creators?: CreatorCreditInput[];
  contributors?: CreatorCreditInput[];
  extraFields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ItemMetadata {
  doi?: string;
  arxivId?: string;
  primaryCategory?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;

  title?: string;
  shortTitle?: string;
  authors?: string[];
  creators?: CreatorCreditInput[];
  editors?: string[];
  year?: number | null;
  publicationDate?: string;
  date?: string;
  accessedAt?: string | Date | null;
  journal?: string;
  journalAbbr?: string;
  publicationTitle?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  partNumber?: string;
  partTitle?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  edition?: string;
  pages?: string;
  abstract?: string;
  abstractNote?: string;
  citationCount?: number;
  referenceCount?: number;
  language?: string;
  url?: string;
  pdfUrl?: string;
  fileUrl?: string;
  fileId?: string;
  filename?: string;
  openAccessPdfUrl?: string;
  itemType?: string;
  type?: string;
  citationKey?: string;
  extra?: string;
  tags?: string[];
  labels?: string[];
  keywords?: string[];
  notes?: Array<{ content: string; source?: string }>;
  rights?: string;
  license?: string;
  archive?: string;
  archiveLocation?: string;
  archiveId?: string;
  repository?: string;
  genre?: string;
  callNumber?: string;
  libraryCatalog?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  eventPlace?: string;
  websiteTitle?: string;
  websiteType?: string;
  blogTitle?: string;
  university?: string;
  institution?: string;
  numPages?: string | number;
  numberOfPages?: number;
  pageCount?: string | number;
  explicitCitationKey?: string;
  reportNumber?: string;
  reportType?: string;
  thesisType?: string;
  versionNumber?: string;
  patentNumber?: string;
  applicationNumber?: string;
  assignee?: string;
  issuingAuthority?: string;
  distributor?: string;
  system?: string;
  extraFields?: Record<string, unknown>;
  seeAlso?: string[];
  relations?:
    | Record<string, string | string[]>
    | Array<{
        targetItemId?: string;
        relationType?: string;
        description?: string;
      }>;

  isRetracted?: boolean;
  retractionNature?: string;
  retractionDetails?: unknown;
  retractionCheckedAt?: string;

  provenance?: any;
  [key: string]: unknown;
}

// ── Canonical Document Structure Types (Standardized In-Process Types) ────────
export interface AcademicCreator {
  fullName: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
  affiliation?: string;
  institution?: string;
  department?: string;
  country?: string;
  isCorresponding?: boolean;
}

export interface BoundingBoxCoordinates {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BibliographicReference {
  id?: string;
  title?: string;
  authors: string[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  arxivId?: string;
  rawCitation?: string;
}

export interface DocumentSection {
  id?: string;
  title: string;
  content: string;
  paragraphs?: string[];
  page?: number;
  level?: number;
  imradCategory?:
    | 'introduction'
    | 'methods'
    | 'results'
    | 'discussion'
    | 'conclusion'
    | 'other';
  coords?: BoundingBoxCoordinates;
}

export interface DocumentFigure {
  id?: string;
  caption?: string;
  graphicUrl?: string;
  coords?: BoundingBoxCoordinates;
}

export interface DocumentTable {
  id?: string;
  caption?: string;
  matrix?: string[][];
  markdown?: string;
  coords?: BoundingBoxCoordinates;
}

export interface DocumentFormula {
  id?: string;
  latex?: string;
  coords?: BoundingBoxCoordinates;
}

export interface DocumentHeaderResult {
  title?: string;
  authors?: string[];
  creators?: AcademicCreator[];
  abstract?: string;
  doi?: string;
  arxivId?: string;
  year?: number;
  publicationDate?: string;
  journal?: string;
  bookTitle?: string;
  conferenceName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  place?: string;
  issn?: string;
  isbn?: string;
  keywords?: string[];
  notes?: Array<{ content: string; type?: string }>;
}
