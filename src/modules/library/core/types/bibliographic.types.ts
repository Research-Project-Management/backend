/**
 * Canonical Bibliographic Types & Constants for Library Shared Kernel.
 * Aligned with Zotero v42 schema and CSL v1.0.2 standards.
 */
import type { Prisma } from '@prisma/client';
import type { TransactionHelpers } from '../ports/unit-of-work.port';

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
  type?: string;
  editors?: string[];
  journal?: string;
  journalAbbr?: string;
  journalAbbreviation?: string;
  publicationTitle?: string;
  publicationDate?: string;
  date?: string;
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
  archiveId?: string;
  archiveID?: string;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  PMID?: string;
  PMCID?: string;
  primaryCategory?: string;
  url?: string;
  accessedAt?: Date | null;
  accessDate?: string;
  archive?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  callNumber?: string;
  rights?: string;
  license?: string;
  language?: string;
  edition?: string;
  shortTitle?: string;
  citationKey?: string;
  citeKey?: string;
  extra?: string;
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
  num?: string;
  title: string;
  content?: string;
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

export interface UpdateItemData extends Partial<CreateItemData> {
  expectedVersion?: number;
}

export interface ItemSummary {
  id: string;
  projectId?: string;
  userId?: string;
  title: string;
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

export interface QualityAuditCandidateItem {
  id: string;
  title: string;
  doi: string | null;
  abstract: string | null;
  year: number | null;
  contributors: Array<{ id: string }>;
  publicationTitle: string | null;
}

export interface DuplicateCandidateItem {
  id: string;
  title: string;
  itemType?: string | null;
  type?: string | null;
  doi: string | null;
  arxivId?: string | null;
  isbn: string | null;
  issn: string | null;
  pmid: string | null;
  citationKey: string | null;
  year: number | null;
  metadata?: Record<string, unknown> | null;
  contributors: Array<{
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    orderIndex: number;
  }>;
}

export interface NoteEntity {
  id: string;
  projectId?: string | null;
  itemId?: string | null;
  title: string;
  contentJson?: unknown;
  contentMd?: string | null;
  tags?: string[];
  createdById?: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateNoteData {
  projectId?: string;
  itemId?: string | null;
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
  createdById?: string;
}

// Item Type Conversion Types
export interface ItemTypeConversionFieldDiff {
  key: string;
  label: string;
  sourceValue: unknown;
  targetValue: unknown;
  status: 'preserved' | 'mapped' | 'cleared';
  baseSemantic?: string;
}

export interface ItemTypeConversionRoleDiff {
  creatorId?: string;
  name: string;
  sourceRole: string;
  targetRole: string;
  changed: boolean;
}

export interface FieldMappingChange {
  fromField: string;
  toField: string;
  value: unknown;
  rule: 'direct' | 'base-semantic' | 'special-rule';
}

export interface DroppedField {
  field: string;
  label: string;
  value: unknown;
}

export interface CreatorRoleChange {
  creator: Record<string, unknown>;
  fromRole: string;
  toRole: string;
  reason: 'preserved' | 'primary-fallback' | 'secondary-fallback';
}

export interface TypeConversionPreview {
  sourceType: string;
  targetType: string;
  preservedFields: string[];
  mappedFields: FieldMappingChange[];
  droppedFields: DroppedField[];
  newAvailableFields: string[];
  creatorChanges: CreatorRoleChange[];
  projectedItem: Record<string, unknown>;
  unmappedRetained: Record<string, unknown>;
  hasLoss: boolean;
}

export interface ConvertTypeOptions {
  expectedVersion?: number;
  retainUnmappedInExtra?: boolean;
}

export const ITEM_TRANSFORMER_PORT = Symbol('ITEM_TRANSFORMER_PORT');

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface ItemTransactionContext<TTx = Prisma.TransactionClient> {
  tx: TTx;
  helpers: TransactionHelpers;
}

