export interface CreatorInput {
  creatorType: string;
  name?: string;
  firstName?: string;
  lastName?: string;
}

export interface Provenance {
  provider?:
    | 'CrossRef'
    | 'arXiv'
    | 'PubMed'
    | 'OpenLibrary'
    | 'SemanticScholar'
    | 'OpenAlex'
    | 'Unpaywall'
    | 'PDF'
    | 'Manual'
    | (string & {});
  originProvider?: string;
  resolvedAt: string;
  canonicalId: string;
  canonicalUrl?: string;
  confidenceScore: number;
  rawSnapshotHash?: string;
  isOpenAccess: boolean;
  openAccessPdfUrl?: string;
}

export interface ItemMetadata {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;

  title?: string;
  shortTitle?: string;
  authors?: string[];
  creators?: CreatorInput[];
  editors?: string[];
  year?: number | null;
  publicationDate?: string;
  date?: string;
  journal?: string;
  journalAbbr?: string;
  publicationTitle?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  series?: string;
  seriesTitle?: string;
  pages?: string;
  abstract?: string;
  abstractNote?: string;
  tldr?: string;
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  language?: string;
  url?: string;
  pdfUrl?: string;
  fileUrl?: string;
  filename?: string;
  storageId?: string;
  openAccessPdfUrl?: string;
  itemType?: string;
  citationKey?: string;
  explicitCitationKey?: string;
  extra?: string;
  tags?: string[];
  labels?: string[];
  keywords?: string[];
  notes?: Array<{ content: string; source?: string }>;
  rights?: string;
  license?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  libraryCatalog?: string;

  provenance?: Provenance;
}

export type UnifiedAcademicMetadata = ItemMetadata;
export type ProvenanceMetadata = Provenance;
export type LibraryCreatorInput = CreatorInput;

export interface MetadataCandidate {
  id: string;
  sourceProvider: string;
  metadata: ItemMetadata;
  confidenceScore: number;
  rawPayload?: unknown;
  fetchedAt: string;
}

export interface FieldAssertion {
  field: string;
  value: unknown;
  sourceProvider: string;
  confidenceScore: number;
  isUserOverride: boolean;
  timestamp: string;
}

export interface MetadataConflict {
  field: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  variants: {
    sourceProvider: string;
    value: unknown;
    confidenceScore: number;
  }[];
}

export interface ConflictReport {
  hasConflicts: boolean;
  conflicts: MetadataConflict[];
}

export interface ReconciledMetadataResult {
  metadata: ItemMetadata;
  assertions: FieldAssertion[];
  candidates: MetadataCandidate[];
  conflictReport: ConflictReport;
  reconciledAt: string;
}

export function extractYearFromDate(
  dateStr?: string | null,
): number | undefined {
  if (!dateStr || typeof dateStr !== 'string') return undefined;
  const match = dateStr.match(/\b(19\d\d|20\d\d)\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

export function normalizeCreators(
  creators?: CreatorInput[] | null,
  fallbackAuthors?: string[] | null,
): CreatorInput[] {
  if (Array.isArray(creators) && creators.length > 0) {
    return creators.map((c) => ({
      creatorType: c.creatorType || 'author',
      name:
        c.name ||
        [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
        'Unknown',
      firstName: c.firstName,
      lastName: c.lastName,
    }));
  }
  if (Array.isArray(fallbackAuthors) && fallbackAuthors.length > 0) {
    return fallbackAuthors.map((name) => ({
      creatorType: 'author',
      name: name.trim(),
    }));
  }
  return [];
}

import {
  ZOTERO_SCHEMA_ITEM_TYPES,
  ALL_CREATOR_TYPES,
  FIELD_DEFINITIONS,
  normalizeCanonicalItemType,
} from '../../../common/zotero-schema';

export function normalizeItemType(type?: string | null): string {
  return normalizeCanonicalItemType(type);
}
export const normalizeLibraryItemType = normalizeItemType;

export function normalizeTags(
  tags?: (string | { tag: string })[] | null,
): string[] {
  if (!Array.isArray(tags)) return [];
  const set = new Set<string>();
  for (const item of tags) {
    const str = typeof item === 'string' ? item : item?.tag;
    if (str && typeof str === 'string' && str.trim()) {
      set.add(str.trim());
    }
  }
  return Array.from(set);
}

export const REFERENCE_MANAGER_SCHEMA_VERSION = 1;

export const SUPPORTED_LIBRARY_ITEM_TYPES = Object.keys(
  ZOTERO_SCHEMA_ITEM_TYPES,
) as Array<keyof typeof ZOTERO_SCHEMA_ITEM_TYPES>;

export type SupportedLibraryItemType =
  (typeof SUPPORTED_LIBRARY_ITEM_TYPES)[number];
export const SELECTABLE_LIBRARY_ITEM_TYPES = SUPPORTED_LIBRARY_ITEM_TYPES;
export const SYSTEM_LIBRARY_ITEM_TYPES = SUPPORTED_LIBRARY_ITEM_TYPES;

export const ITEM_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(ZOTERO_SCHEMA_ITEM_TYPES).map(([k, v]) => [k, v.label]),
);

export const CREATOR_TYPE_LABELS: Record<string, string> = ALL_CREATOR_TYPES;

export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_DEFINITIONS).map(([k, v]) => [k, v.label]),
);

export const ITEM_TYPE_FIELD_KEYS: Record<string, string[]> = Object.fromEntries(
  Object.entries(ZOTERO_SCHEMA_ITEM_TYPES).map(([k, v]) => [
    k,
    v.fields.map((f) => f.field),
  ]),
);

export const ITEM_TYPE_CREATOR_KEYS: Record<string, string[]> = Object.fromEntries(
  Object.entries(ZOTERO_SCHEMA_ITEM_TYPES).map(([k, v]) => [
    k,
    v.creatorTypes.map((c) => c.creatorType),
  ]),
);
