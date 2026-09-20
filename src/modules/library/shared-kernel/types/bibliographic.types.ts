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
  firstName?: string | null;
  lastName?: string | null;
  fullName: string;
}

export interface CreatorCreditInput {
  name?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  creatorType?: CreatorType;
  orderIndex?: number;
}

export type CreatorInput = CreatorCreditInput;

export interface ParsedCreator {
  orderIndex: number;
  creatorType: CreatorType;
  firstName: string;
  lastName: string;
  fullName: string;
}

// ── Persistent Identifiers ───────────────────────────────────────────────────
export type IdentifierScheme =
  'doi' | 'arxiv' | 'pmid' | 'isbn' | 'issn' | 'url' | 'urn' | (string & {});

// ── Tag Input ────────────────────────────────────────────────────────────────
export type TagObjectInput = { tag?: string; name?: string; type?: number };
export type TagInput = string | TagObjectInput;

// ── Canonical Field Mappings ────────────────────────────────────────────────
export const BASE_FIELD_MAPPINGS: Record<string, string> = {
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
