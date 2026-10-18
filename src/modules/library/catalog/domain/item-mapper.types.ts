import type { CreatorCreditInput } from '@/modules/library/catalog/types/items.types';

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
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  attachments?: AttachmentLike[];
  userStates?: Array<Record<string, unknown>>;
  states?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown> | string | null;
  contributors?: CreatorCreditInput[];
  creators?: CreatorCreditInput[];
  authors?: unknown;
  editors?: unknown;
  itemTags?: Array<Record<string, unknown>>;
  tags?: unknown;
  keywords?: unknown;
  zoteroTags?: unknown;
  collectionItems?: Array<Record<string, unknown>>;
  collectionId?: string | null;
  collectionIds?: string[];
  collections?: unknown[];
  notesList?: Array<Record<string, unknown>>;
  notes?: Array<Record<string, unknown>>;
  extraFields?: Record<string, unknown>;
  extra?: unknown;
  citationCount?: number | string | null;
  referenceCount?: number | string | null;
  openAccessPdfUrl?: string | null;
  doi?: string | null;
  DOI?: string | null;
  arxivId?: string | null;
  archiveId?: string | null;
  archiveID?: string | null;
  isbn?: string | null;
  ISBN?: string | null;
  issn?: string | null;
  ISSN?: string | null;
  pmid?: string | null;
  PMID?: string | null;
  pmcid?: string | null;
  PMCID?: string | null;
  identifiers?: ItemIdentifierLike[];
  seriesNumber?: string | null;
  edition?: string | null;
  numPages?: number | string | null;
  numberOfPages?: number | string | null;
  proceedingsTitle?: string | null;
  conferenceName?: string | null;
  institution?: string | null;
  university?: string | null;
  reportNumber?: string | null;
  reportType?: string | null;
  thesisType?: string | null;
  repository?: string | null;
  country?: string | null;
  websiteTitle?: string | null;
  websiteType?: string | null;
  blogTitle?: string | null;
  issuingAuthority?: string | null;
  authority?: string | null;
  patentNumber?: string | null;
  issueDate?: string | null;
  priorityDate?: string | null;
  originalDate?: string | null;
  assignee?: string | null;
  rights?: string | null;
  license?: string | null;
  abstract?: string | null;
  abstractNote?: string | null;
  year?: number | string | null;
  date?: string | null;
  publicationDate?: string | null;
  publicationTitle?: string | null;
  journal?: string | null;
  journalAbbreviation?: string | null;
  journalAbbr?: string | null;
  place?: string | null;
  eventPlace?: string | null;
  bookTitle?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  callNumber?: string | null;
  accessDate?: string | null;
  accessedAt?: string | Date | null;
  citationKey?: string | null;
  citeKey?: string | null;
  genre?: string | null;
  number?: string | null;
  isStarred?: boolean;
  readStatus?: string;
  rating?: number;
  lastReadAt?: string | Date | null;
  itemType?: string;
  type?: string;
  fileUrl?: string | null;
  filename?: string;
  mimeType?: string;
  size?: number;
  primaryFile?: Record<string, unknown> | null;
  isMyPublication?: boolean;
  publications?: unknown[];
  outgoingRel?: Array<Record<string, unknown>>;
  incomingRel?: Array<Record<string, unknown>>;
  relations?: unknown[];
  seeAlso?: unknown;
  [key: string]: unknown;
};

export function parseJsonObject(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  if (typeof val === 'string' && val.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(val.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}
