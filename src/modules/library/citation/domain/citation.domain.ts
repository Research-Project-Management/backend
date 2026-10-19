import {
  CitationStyleId,
  ReferenceData,
} from '@/modules/library/citation/types/citation.types';
import { cleanBibliographicText } from '@/modules/library/core';

export interface RawCslWorkInput {
  message?: RawCslWorkInput;
  title?: string | string[];
  author?: Array<{
    given?: string;
    family?: string;
    name?: string;
    literal?: string;
  }>;
  'published-print'?: { 'date-parts'?: (number | string)[][] };
  'published-online'?: { 'date-parts'?: (number | string)[][] };
  issued?: { 'date-parts'?: (number | string)[][] };
  DOI?: string;
  'container-title'?: string | string[];
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  ISSN?: string | string[];
  ISBN?: string | string[];
  URL?: string;
  abstract?: string;
  type?: string;
  score?: number;
}

/**
 * Validates whether a given citation style identifier is a valid slug or recognized style.
 * Accepts standard names as well as 10,000+ CSL repository journal slugs.
 */
export function isSupportedCitationStyle(
  styleId: string,
): styleId is CitationStyleId {
  if (!styleId || typeof styleId !== 'string') return false;
  const clean = styleId.toLowerCase().trim();
  return /^[a-z0-9_-]+$/.test(clean);
}

/**
 * Normalizes citation style string with fallback to 'apa-7th'.
 */
export function normalizeCitationStyleId(styleId?: string): CitationStyleId {
  if (!styleId) return 'apa-7th';
  const clean = styleId.toLowerCase().trim();
  return isSupportedCitationStyle(clean) ? clean : 'apa-7th';
}

/**
 * Normalizes a CrossRef message or CSL-JSON work payload into a canonical ReferenceData record.
 */
export function normalizeWork(
  rawInput?: RawCslWorkInput | Record<string, unknown> | null,
  fallbackDoi: string = '',
): ReferenceData {
  const csl = (
    rawInput &&
    typeof rawInput === 'object' &&
    'message' in rawInput &&
    rawInput.message &&
    typeof rawInput.message === 'object'
      ? rawInput.message
      : rawInput || {}
  ) as RawCslWorkInput;

  const rawTitle = Array.isArray(csl.title)
    ? csl.title[0] || 'Untitled'
    : csl.title || 'Untitled';
  const title = fallbackDoi
    ? cleanBibliographicText(rawTitle) || 'Untitled'
    : rawTitle;

  const authors: string[] = [];
  if (Array.isArray(csl.author)) {
    for (const auth of csl.author) {
      if (auth.given && auth.family) {
        authors.push(`${auth.family}, ${auth.given}`);
      } else if (auth.family) {
        authors.push(auth.family);
      } else if (auth.name) {
        authors.push(auth.name);
      } else if (auth.literal) {
        authors.push(auth.literal);
      }
    }
  }

  let year: number | string = '';
  const dateParts =
    csl['published-print']?.['date-parts']?.[0] ||
    csl['published-online']?.['date-parts']?.[0] ||
    csl.issued?.['date-parts']?.[0];
  if (dateParts && dateParts[0]) {
    year = Number(dateParts[0]);
  }

  const journal = Array.isArray(csl['container-title'])
    ? csl['container-title'][0]
    : csl['container-title'] || (fallbackDoi ? csl.publisher || '' : '');

  const doi = csl.DOI || fallbackDoi;

  return {
    doi,
    title,
    authors,
    year,
    journal,
    publisher: csl.publisher || '',
    volume: csl.volume || '',
    issue: csl.issue || '',
    pages: csl.page || '',
    issn: Array.isArray(csl.ISSN) ? csl.ISSN[0] : csl.ISSN || '',
    isbn: Array.isArray(csl.ISBN) ? csl.ISBN[0] : csl.ISBN || '',
    url: csl.URL || (doi ? `https://doi.org/${doi}` : ''),
    abstract: csl.abstract ? csl.abstract.replace(/<[^>]*>/g, '') : '',
    type: csl.type || 'journal-article',
    itemType:
      csl.type === 'journal-article' || csl.type === 'article-journal'
        ? 'journalArticle'
        : csl.type === 'dataset'
          ? 'dataset'
          : csl.type === 'paper-conference'
            ? 'conferencePaper'
            : csl.type === 'book'
              ? 'book'
              : csl.type || 'journalArticle',
    ...(csl.score !== undefined ? { score: csl.score } : fallbackDoi ? {} : { score: 0 }),
  };
}
