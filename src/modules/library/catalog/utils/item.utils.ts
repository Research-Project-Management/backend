import { CreatorInput, IdentifierScheme } from '../types/catalog.types';

export function normalizeDoi(doi?: string | null): string | undefined {
  if (!doi || typeof doi !== 'string') return undefined;
  let clean = doi.trim();

  clean = clean.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  clean = clean.replace(/[.,;)\]]+$/, '');

  const match = clean.match(/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/);
  if (!match) {
    const embedded = clean.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
    return embedded ? embedded[0].toLowerCase() : undefined;
  }

  return clean.toLowerCase();
}

export function normalizeArxivId(
  arxiv?: string | null,
  options?: { stripVersion?: boolean },
): string | undefined {
  if (!arxiv || typeof arxiv !== 'string') return undefined;
  let clean = arxiv.trim();

  clean = clean.replace(
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)/i,
    '',
  );
  clean = clean.replace(/\.pdf$/i, '');
  if (options?.stripVersion) {
    clean = clean.replace(/v\d+$/i, '');
  }

  const newFormat = clean.match(/^\d{4}\.\d{4,5}(?:v\d+)?$/i);
  if (newFormat) return newFormat[0];

  const oldFormat = clean.match(/^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/i);
  if (oldFormat) return oldFormat[0].toLowerCase();

  return undefined;
}

export function normalizePmid(
  pmid?: string | number | null,
): string | undefined {
  if (pmid === null || pmid === undefined) return undefined;
  const str = String(pmid)
    .trim()
    .replace(/^(?:pmid:\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)/i, '')
    .replace(/\/$/, '');
  return /^\d{1,9}$/.test(str) ? str : undefined;
}

export function normalizePmcid(pmcid?: string | null): string | undefined {
  if (!pmcid || typeof pmcid !== 'string') return undefined;
  const clean = pmcid
    .trim()
    .toUpperCase()
    .replace(
      /^(?:PMCID:\s*|PMC:\s*|HTTPS?:\/\/WWW\.NCBI\.NLM\.NIH\.GOV\/PMC\/ARTICLES\/)/i,
      '',
    )
    .replace(/\/$/, '');
  const digits = clean.replace(/^PMC/, '');
  return /^\d{1,9}$/.test(digits) ? `PMC${digits}` : undefined;
}

export function normalizeIsbn(isbn?: string | null): string | undefined {
  if (!isbn || typeof isbn !== 'string') return undefined;
  const digits = isbn
    .replace(/^isbn:?\s*/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (/^(?:978|979)\d{10}$/.test(digits) || /^\d{9}[\dX]$/.test(digits)) {
    return digits;
  }
  return undefined;
}

export function normalizeIssn(issn?: string | null): string | undefined {
  if (!issn || typeof issn !== 'string') return undefined;
  const clean = issn
    .replace(/^issn:?\s*/i, '')
    .replace(/[-\s]/g, '')
    .toUpperCase();
  if (/^\d{7}[\dX]$/.test(clean)) {
    return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  }
  return undefined;
}

export function formatCanonicalId(
  scheme: IdentifierScheme,
  value?: string | number | null,
): string | undefined {
  if (!value) return undefined;
  const strVal = typeof value === 'number' ? String(value) : value;
  const normalizers: Record<IdentifierScheme, string | undefined> = {
    doi: normalizeDoi(strVal),
    arxiv: normalizeArxivId(strVal),
    pmid: normalizePmid(value),
    pmcid: normalizePmcid(strVal),
    isbn: normalizeIsbn(strVal),
    issn: normalizeIssn(strVal),
    uri: strVal?.trim() || undefined,
    custom: strVal?.trim() || undefined,
  };

  const normalized = normalizers[scheme];
  return normalized ? `${scheme}:${normalized}` : undefined;
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

export const BIBLIOGRAPHIC_ITEM_TYPES = [
  'artwork',
  'audioRecording',
  'bill',
  'blogPost',
  'book',
  'bookSection',
  'case',
  'computerProgram',
  'conferencePaper',
  'dataset',
  'dictionaryEntry',
  'document',
  'email',
  'encyclopediaArticle',
  'film',
  'forumPost',
  'hearing',
  'instantMessage',
  'interview',
  'journalArticle',
  'letter',
  'magazineArticle',
  'manuscript',
  'map',
  'newspaperArticle',
  'patent',
  'podcast',
  'preprint',
  'presentation',
  'radioBroadcast',
  'report',
  'standard',
  'statute',
  'thesis',
  'tvBroadcast',
  'videoRecording',
  'webpage',
] as const;

export const SPECIAL_ITEM_TYPES = ['attachment', 'note', 'annotation'] as const;

export const CANONICAL_ITEM_TYPES = new Set<string>([
  ...BIBLIOGRAPHIC_ITEM_TYPES,
  ...SPECIAL_ITEM_TYPES,
]);

const ITEM_TYPE_ALIASES: Record<string, string> = {
  paper: 'journalArticle',
  article: 'journalArticle',
  journal_article: 'journalArticle',
  'journal-article': 'journalArticle',
  conference_paper: 'conferencePaper',
  'conference-paper': 'conferencePaper',
  proceeding: 'conferencePaper',
  proceedings: 'conferencePaper',
  inproceedings: 'conferencePaper',
  book_section: 'bookSection',
  'book-section': 'bookSection',
  chapter: 'bookSection',
  incollection: 'bookSection',
  inbook: 'bookSection',
  dissertation: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  techreport: 'report',
  software: 'computerProgram',
  code: 'computerProgram',
  program: 'computerProgram',
  data: 'dataset',
  spec: 'standard',
  specification: 'standard',
  rfc: 'standard',
  web: 'webpage',
  website: 'webpage',
  online: 'webpage',
  audio: 'audioRecording',
  sound: 'audioRecording',
  video: 'videoRecording',
  movie: 'film',
  tv: 'tvBroadcast',
  radio: 'radioBroadcast',
  blog: 'blogPost',
  forum: 'forumPost',
  mail: 'email',
  message: 'instantMessage',
  talk: 'presentation',
  slide: 'presentation',
  slides: 'presentation',
};

export function normalizeItemType(type?: string | null): string {
  if (!type) return 'journalArticle';
  const trimmed = type.trim();
  if (CANONICAL_ITEM_TYPES.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (ITEM_TYPE_ALIASES[lower]) return ITEM_TYPE_ALIASES[lower];
  for (const canonical of CANONICAL_ITEM_TYPES) {
    if (canonical.toLowerCase() === lower) return canonical;
  }
  return 'journalArticle';
}
export const normalizeLibraryItemType = normalizeItemType;

export function extractFamilyName(authorName?: string | null): string {
  if (!authorName) return '';
  const trimmed = authorName.trim();
  if (trimmed.includes(',')) {
    return trimmed.split(',')[0].trim();
  }
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || '';
}
