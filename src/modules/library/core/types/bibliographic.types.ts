/**
 * Canonical Bibliographic Types & Constants for Library Shared Kernel.
 * Aligned with Zotero v42 schema and CSL v1.0.2 standards.
 */
import type { Prisma } from '@prisma/client';

import { SCHEMA_V42_DATA } from './schema.constants';

// Creator & Contributor Roles
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
  [key: string]: unknown;
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

// Persistent Identifiers
export type IdentifierScheme =
  'doi' | 'arxiv' | 'pmid' | 'isbn' | 'issn' | 'url' | 'urn' | (string & {});

// Tag Input
export type TagObjectInput = {
  tag?: string;
  name?: string;
  type?: number | string;
};
export type TagInput = string | TagObjectInput;

export const PRISMA_ITEM_SCALAR_COLUMNS = [
  'title',
  'itemType',
  'year',
  'citationKey',
  'doi',
  'isbn',
  'issn',
  'pmid',
  'pmcid',
  'arxivId',
  'publicationTitle',
  'abstract',
  'url',
  'firstAuthor',
] as const;

export const INTERNAL_SYSTEM_AND_TELEMETRY_KEYS = [
  'ingestionStatus',
  'extractionStatus',
  'enrichmentStatus',
  'matchStatus',
  'confidenceScore',
  'verificationScore',
  'qualityScore',
  'isVerified',
  'isSelfSufficient',
  'isUnindexed',
  'isFilenameTitle',
  'xmpFound',
  'ocrApplied',
  'pageCount',
  'matchedSignals',
  'missingFields',
  'engineUsed',
  'wafKind',
  'statusCode',
  'provenance',
  'fieldProvenance',
  'contentHash',
  'sourceUrl',
  'pdfUrl',
  'fileUrl',
  'openAccessPdfUrl',
  'demotedToExtra',
  'demotedExtraLines',
  '__demotedExtraLines',
  'dismissedDuplicateIds',
  'mergedDuplicateIds',
  'mergedCitationKeys',
  'mergedFromIds',
  'mergedIntoId',
  'mergeHistory',
  'retraction',
  'retractionDetails',
  'isRetracted',
  'retractionNature',
  'retractionCheckedAt',
  'retractionStatus',
  'retractionDate',
  'retractionReasons',
  'retractionNoticeDoi',
  'retractionSource',
  'isMyPublication',
  'myPublicationNote',
  'myPublicationAddedAt',
  'openAccessLicense',
] as const;

export const CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS = [
  'title',
  'year',
  'doi',
  'DOI',
  'abstract',
  'abstractNote',
  'itemType',
  'type',
  'publicationTitle',
  'journal',
  'publicationDate',
  'date',
  'publisher',
  'place',
  'volume',
  'issue',
  'section',
  'partNumber',
  'partTitle',
  'pages',
  'series',
  'seriesTitle',
  'seriesText',
  'seriesNumber',
  'issn',
  'ISSN',
  'isbn',
  'ISBN',
  'pmid',
  'PMID',
  'pmcid',
  'PMCID',
  'url',
  'language',
  'journalAbbr',
  'journalAbbreviation',
  'shortTitle',
  'rights',
  'license',
  'citationKey',
  'citeKey',
  'libraryCatalog',
  'archive',
  'archiveLocation',
  'callNumber',
  'accessedAt',
  'accessDate',
  'extra',
  'arxivId',
  'archiveId',
  'archiveID',
  'citationCount',
  'referenceCount',
  'openAccessPdfUrl',
] as const;

export const ITEM_COLUMN_METADATA_FIELDS = new Set<string>(
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
);

export const TYPE_SPECIFIC_EXTRA_FIELDS = [
  ...new Set(
    Object.values(SCHEMA_V42_DATA.itemTypes)
      .flatMap((itemType) => itemType.fields.map((field) => field.key))
      .filter((field) => !ITEM_COLUMN_METADATA_FIELDS.has(field)),
  ),
];

export interface CreateItemData {
  title: string;
  authors?: string[];
  year?: number | null;
  doi?: string | null;
  abstract?: string | null;
  /** Zotero alias for abstract. Either field may be provided; they are kept
   *  in sync throughout the stack. Stored in the single DB `abstract` column. */
  abstractNote?: string | null;
  itemType?: string;
  type?: string;
  editors?: string[];
  journal?: string | null;
  journalAbbr?: string | null;
  journalAbbreviation?: string | null;
  publicationTitle?: string | null;
  publicationDate?: string | null;
  date?: string | null;
  publisher?: string | null;
  place?: string | null;
  volume?: string | number | null;
  issue?: string | number | null;
  section?: string | null;
  partNumber?: string | null;
  partTitle?: string | null;
  pages?: string | number | null;
  series?: string | null;
  seriesTitle?: string | null;
  seriesText?: string | null;
  seriesNumber?: string | number | null;
  issn?: string | null;
  isbn?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  arxivId?: string | null;
  archiveId?: string | null;
  archiveID?: string | null;
  DOI?: string | null;
  ISBN?: string | null;
  ISSN?: string | null;
  PMID?: string | null;
  PMCID?: string | null;
  primaryCategory?: string | null;
  url?: string | null;
  accessedAt?: Date | string | null;
  accessDate?: string | null;
  archive?: string | null;
  archiveLocation?: string | null;
  libraryCatalog?: string | null;
  callNumber?: string | null;
  rights?: string | null;
  license?: string | null;
  language?: string | null;
  edition?: string | null;
  shortTitle?: string | null;
  citationKey?: string | null;
  citeKey?: string | null;
  extra?: string | null;
  tags?: string[];
  labels?: string[];
  keywords?: string[];
  notes?: unknown[] | string[] | null;
  fileUrl?: string;
  fileId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  fileHash?: string;
  attachments?: Array<
    Record<string, unknown> & {
      id?: string;
      title?: string;
      filename?: string;
      url?: string;
      fileId?: string | null;
      fileHash?: string | null;
      mimeType?: string;
      size?: number;
      linkMode?: string;
      attachmentType?: string;
      metadata?: Record<string, unknown>;
    }
  >;
  collectionId?: string | null;
  collectionIds?: string[] | null;
  uploadedById?: string;
  userId?: string;
  projectId?: string | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  openAccessPdfUrl?: string | null;
  isRetracted?: boolean;
  retractionCheckedAt?: Date | string | null;
  retractionNature?: string | null;
  retractionDetails?: Record<string, unknown> | unknown | null;
  isMyPublication?: boolean;
  metadata?: Record<string, unknown>;
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
  attachments?: CreateItemData['attachments'];
  isSelfSufficient?: boolean;
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
  numberOfPages?: number | string;
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

  provenance?: unknown;
  [key: string]: unknown;
}

// Canonical Document Structure Types (Standardized In-Process Types)
export interface ItemCreator {
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
  fieldMode?: number;
  creatorType?: string;
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
  num?: string;
  title: string;
  content?: string;
  paragraphs?: string[];
  page?: number;
  pageNumber?: number;
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

export interface UpdateItemData extends Partial<CreateItemData> {
  expectedVersion?: number;
}

export interface ItemSummary {
  id: string;
  projectId?: string;
  userId?: string;
  title: string;
  abstract?: string | null;
  itemType?: string;
  year?: number | null;
  doi?: string | null;
  primaryAuthors?: string[];
  version?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ItemDetail {
  id: string;
  title: string;
  shortTitle?: string | null;
  userId?: string;
  projectId?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  doi?: string | null;
  isbn?: string | null;
  issn?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  arxivId?: string | null;
  primaryCategory?: string | null;
  citationKey?: string | null;
  itemType?: string | null;
  type?: string | null;
  authors?: string[];
  editors?: string[];
  year?: number | null;
  publicationDate?: string | null;
  date?: string | null;
  accessedAt?: string | Date | null;
  accessDate?: string | null;
  abstract?: string | null;
  abstractNote?: string | null;
  publicationTitle?: string | null;
  journal?: string | null;
  journalAbbr?: string | null;
  journalAbbreviation?: string | null;
  publisher?: string | null;
  place?: string | null;
  volume?: string | null;
  issue?: string | null;
  section?: string | null;
  partNumber?: string | null;
  partTitle?: string | null;
  series?: string | null;
  seriesTitle?: string | null;
  seriesText?: string | null;
  seriesNumber?: string | null;
  edition?: string | null;
  pages?: string | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  language?: string | null;
  url?: string | null;
  pdfUrl?: string | null;
  fileUrl?: string | null;
  fileId?: string | null;
  filename?: string | null;
  openAccessPdfUrl?: string | null;
  extra?: string | null;
  tags?: string[];
  labels?: string[];
  keywords?: string[];
  notes?: Array<{ content: string; source?: string }>;
  identifiers?: Array<{
    id?: string;
    type: string;
    value: string;
    canonicalUri?: string | null;
  }>;
  attachments?: unknown[];
  rights?: string | null;
  license?: string | null;
  archive?: string | null;
  archiveLocation?: string | null;
  archiveId?: string | null;
  repository?: string | null;
  genre?: string | null;
  callNumber?: string | null;
  libraryCatalog?: string | null;
  bookTitle?: string | null;
  proceedingsTitle?: string | null;
  conferenceName?: string | null;
  eventPlace?: string | null;
  websiteTitle?: string | null;
  websiteType?: string | null;
  blogTitle?: string | null;
  university?: string | null;
  institution?: string | null;
  numPages?: string | number | null;
  numberOfPages?: number | string | null;
  pageCount?: string | number | null;
  reportNumber?: string | null;
  reportType?: string | null;
  thesisType?: string | null;
  versionNumber?: string | null;
  patentNumber?: string | null;
  applicationNumber?: string | null;
  assignee?: string | null;
  issuingAuthority?: string | null;
  distributor?: string | null;
  system?: string | null;
  extraFields?: Record<string, unknown>;
  metadata?: Prisma.JsonValue | Record<string, unknown> | null;
  fields?: Record<string, unknown> | null;
  isRetracted?: boolean;
  retractionNature?: string | null;
  retractionDetails?: unknown;
  retractionCheckedAt?: string | Date | null;
  creators?: CreatorCredit[];
  contributors?: CreatorCredit[];
  [key: string]: unknown;
}

export interface AttachmentLike {
  attachmentType?: string;
  mimeType?: string;
  filename?: string;
  fileId?: string | null;
  title?: string;
  metadata?: { title?: string; [key: string]: unknown } | null;
  url?: string;
  revisions?: Array<{ url?: string; [key: string]: unknown }>;
  size?: number;
  [key: string]: unknown;
}

export interface ItemIdentifierLike {
  type?: string;
  identifierType?: string;
  value?: string;
  canonicalUri?: string | null;
  [key: string]: unknown;
}

export type MutableItemPayload = Record<string, unknown> & {
  id?: string; createdAt?: string; updatedAt?: string;
  attachments?: AttachmentLike[]; states?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown> | string | null;
  contributors?: CreatorCreditInput[]; creators?: CreatorCreditInput[];
  authors?: unknown; editors?: unknown; itemTags?: Array<Record<string, unknown>>;
  tags?: unknown; keywords?: unknown; zoteroTags?: unknown;
  collectionItems?: Array<Record<string, unknown>>; collectionId?: string | null;
  collectionIds?: string[]; collections?: unknown[];
  notesList?: Array<Record<string, unknown>>; notes?: Array<Record<string, unknown>>;
  extraFields?: Record<string, unknown>; extra?: unknown;
  citationCount?: number | string | null; referenceCount?: number | string | null;
  openAccessPdfUrl?: string | null; doi?: string | null; DOI?: string | null;
  arxivId?: string | null; archiveId?: string | null; archiveID?: string | null;
  isbn?: string | null; ISBN?: string | null; issn?: string | null; ISSN?: string | null;
  pmid?: string | null; PMID?: string | null; pmcid?: string | null; PMCID?: string | null;
  identifiers?: ItemIdentifierLike[]; seriesNumber?: string | null; edition?: string | null;
  numPages?: number | string | null; numberOfPages?: number | string | null;
  proceedingsTitle?: string | null; conferenceName?: string | null;
  institution?: string | null; university?: string | null;
  reportNumber?: string | null; reportType?: string | null;
  thesisType?: string | null; repository?: string | null;
  country?: string | null; websiteTitle?: string | null;
  websiteType?: string | null; blogTitle?: string | null;
  issuingAuthority?: string | null; authority?: string | null;
  patentNumber?: string | null; issueDate?: string | null;
  priorityDate?: string | null; originalDate?: string | null;
  assignee?: string | null; rights?: string | null; license?: string | null;
  abstract?: string | null; abstractNote?: string | null;
  year?: number | string | null; date?: string | null; publicationDate?: string | null;
  publicationTitle?: string | null; journal?: string | null;
  journalAbbreviation?: string | null; journalAbbr?: string | null;
  place?: string | null; eventPlace?: string | null; bookTitle?: string | null;
  volume?: string | null; issue?: string | null; pages?: string | null;
  callNumber?: string | null; accessDate?: string | null; accessedAt?: string | Date | null;
  citationKey?: string | null; citeKey?: string | null; genre?: string | null;
  number?: string | null; isStarred?: boolean; readStatus?: string; rating?: number;
  lastReadAt?: string | Date | null; itemType?: string; type?: string;
  fileUrl?: string | null; filename?: string; mimeType?: string; size?: number;
  primaryFile?: Record<string, unknown> | null; isMyPublication?: boolean;
  publications?: unknown[]; outgoingRel?: Array<Record<string, unknown>>;
  incomingRel?: Array<Record<string, unknown>>; relations?: unknown[];
  seeAlso?: unknown; [key: string]: unknown;
};

export * from './schema.types';
