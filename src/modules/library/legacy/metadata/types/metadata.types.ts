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

export function normalizeItemType(type?: string | null): string {
  if (!type || typeof type !== 'string') return 'journalArticle';
  const clean = type.toLowerCase().trim();
  if (clean.includes('book')) return 'book';
  if (clean.includes('thesis') || clean.includes('dissertation'))
    return 'thesis';
  if (clean.includes('conference') || clean.includes('proceeding'))
    return 'conferencePaper';
  if (clean.includes('preprint') || clean.includes('arxiv')) return 'preprint';
  if (clean.includes('report')) return 'report';
  return 'journalArticle';
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

export const SUPPORTED_LIBRARY_ITEM_TYPES = [
  'journalArticle',
  'book',
  'bookSection',
  'conferencePaper',
  'thesis',
  'report',
  'preprint',
  'webpage',
  'document',
] as const;

export type SupportedLibraryItemType =
  (typeof SUPPORTED_LIBRARY_ITEM_TYPES)[number];
export const SELECTABLE_LIBRARY_ITEM_TYPES = SUPPORTED_LIBRARY_ITEM_TYPES;
export const SYSTEM_LIBRARY_ITEM_TYPES = SUPPORTED_LIBRARY_ITEM_TYPES;

export const ITEM_TYPE_LABELS: Record<string, string> = {
  journalArticle: 'Journal Article',
  book: 'Book',
  bookSection: 'Book Section',
  conferencePaper: 'Conference Paper',
  thesis: 'Thesis / Dissertation',
  report: 'Report',
  preprint: 'Preprint',
  webpage: 'Web Page',
  document: 'Document',
};

export const CREATOR_TYPE_LABELS: Record<string, string> = {
  author: 'Author',
  editor: 'Editor',
  contributor: 'Contributor',
  translator: 'Translator',
};

export const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  abstractNote: 'Abstract',
  publicationTitle: 'Publication Title',
  date: 'Date',
  doi: 'DOI',
  url: 'URL',
  volume: 'Volume',
  issue: 'Issue',
  pages: 'Pages',
  publisher: 'Publisher',
  isbn: 'ISBN',
  issn: 'ISSN',
};

export const ITEM_TYPE_FIELD_KEYS: Record<string, string[]> = {
  journalArticle: [
    'title',
    'abstractNote',
    'publicationTitle',
    'volume',
    'issue',
    'pages',
    'date',
    'doi',
    'issn',
    'url',
  ],
  book: ['title', 'abstractNote', 'publisher', 'date', 'isbn', 'url'],
  conferencePaper: [
    'title',
    'abstractNote',
    'publicationTitle',
    'publisher',
    'date',
    'doi',
    'url',
  ],
  preprint: ['title', 'abstractNote', 'date', 'doi', 'url'],
  thesis: ['title', 'abstractNote', 'publisher', 'date', 'url'],
  report: ['title', 'abstractNote', 'publisher', 'date', 'url'],
  webpage: ['title', 'abstractNote', 'url', 'accessDate'],
  document: ['title', 'abstractNote', 'date', 'url'],
};

export const ITEM_TYPE_CREATOR_KEYS: Record<string, string[]> = {
  journalArticle: ['author'],
  book: ['author', 'editor', 'translator'],
  conferencePaper: ['author', 'editor'],
  preprint: ['author'],
  thesis: ['author'],
  report: ['author'],
  webpage: ['author'],
  document: ['author'],
};
