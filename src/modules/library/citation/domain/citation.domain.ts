import {
  CitationStyleId,
  ReferenceData,
  ExportItemRecord,
} from '@/modules/library/citation/types/citation.types';
import { cleanBibliographicText } from '@/modules/library/core';
import { CslJsonMapper } from './csl-json.mapper';

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
    ...(csl.score !== undefined
      ? { score: csl.score }
      : fallbackDoi
        ? {}
        : { score: 0 }),
  };
}

function itemMetaAsRecord(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

/**
 * Extracts merged citation keys (from DuplicateService.mergeDuplicates) and
 * BetterBibTeX tex.ids / Citation Key aliases from item metadata.
 */
export function extractItemCitationAliases(it: ExportItemRecord): string[] {
  const aliases = new Set<string>();
  const metaObj =
    it.metadata && typeof it.metadata === 'object' && !Array.isArray(it.metadata)
      ? itemMetaAsRecord(it.metadata)
      : {};

  const addKey = (val: unknown) => {
    if (typeof val === 'string' && val.trim()) {
      for (const token of val.split(/[,;\s]+/)) {
        const trimmed = token.trim();
        if (trimmed) aliases.add(trimmed);
      }
    }
  };

  if (Array.isArray(metaObj.mergedCitationKeys)) {
    for (const k of metaObj.mergedCitationKeys) addKey(k);
  }
  addKey(metaObj.citationKey);
  addKey(metaObj['citation-key']);
  addKey(metaObj['tex.ids']);

  if (
    metaObj.extra &&
    typeof metaObj.extra === 'object' &&
    !Array.isArray(metaObj.extra)
  ) {
    const extraObj = metaObj.extra as Record<string, unknown>;
    if (Array.isArray(extraObj.mergedCitationKeys)) {
      for (const k of extraObj.mergedCitationKeys) addKey(k);
    }
    addKey(extraObj['tex.ids']);
    addKey(extraObj['citation-key']);
    addKey(extraObj['citationKey']);
    addKey(extraObj['bibtex']);
  }

  const csl = CslJsonMapper.toCsl(it);
  if (typeof csl['citation-key'] === 'string') {
    addKey(csl['citation-key']);
  }

  const rawExtraStr =
    typeof metaObj.extra === 'string'
      ? metaObj.extra
      : typeof (it as Record<string, unknown>).extra === 'string'
        ? ((it as Record<string, unknown>).extra as string)
        : '';
  if (rawExtraStr) {
    const matches = rawExtraStr.matchAll(
      /(?:^|\r?\n)\s*(?:citation[-_\s]*key|cite[-_\s]*key|bibtex(?:\s*key)?|tex\.ids)\s*:\s*([^\r\n]+)/gi,
    );
    for (const match of matches) {
      if (match[1]) {
        addKey(match[1]);
      }
    }
  }

  return Array.from(aliases);
}

export interface EmittedCitationEntry {
  item: ExportItemRecord;
  emitCiteKey: string;
}

export interface ResolvedCitationKeysResult {
  foundKeys: string[];
  missingKeys: string[];
  emittedEntries: EmittedCitationEntry[];
}

export function resolveEmittedCitationEntries(
  allCandidateItems: ExportItemRecord[],
  trimmedKeys: string[],
): ResolvedCitationKeysResult {
  const normalizedKeys = trimmedKeys.map((k) => k.toLowerCase());
  const keySet = new Set(normalizedKeys);
  const originalKeyByLower = new Map<string, string>();
  for (const rawKey of trimmedKeys) {
    const lower = rawKey.toLowerCase();
    if (!originalKeyByLower.has(lower)) {
      originalKeyByLower.set(lower, rawKey);
    }
  }

  const foundKeys: string[] = [];
  const emittedEntries: EmittedCitationEntry[] = [];
  const emittedCiteKeySet = new Set<string>();

  for (const it of allCandidateItems) {
    const primaryCiteKey = it.citationKey || '';
    const itemId = it.id || '';
    const aliases = extractItemCitationAliases(it);

    let itemMatchedPrimary = false;
    if (primaryCiteKey && keySet.has(primaryCiteKey.toLowerCase())) {
      foundKeys.push(primaryCiteKey);
      itemMatchedPrimary = true;
      const lowerPrimary = primaryCiteKey.toLowerCase();
      if (!emittedCiteKeySet.has(lowerPrimary)) {
        emittedCiteKeySet.add(lowerPrimary);
        emittedEntries.push({ item: it, emitCiteKey: primaryCiteKey });
      }
    } else if (itemId && keySet.has(itemId.toLowerCase())) {
      foundKeys.push(itemId);
      itemMatchedPrimary = true;
      const emitKey = primaryCiteKey || itemId;
      const lowerEmit = emitKey.toLowerCase();
      if (!emittedCiteKeySet.has(lowerEmit)) {
        emittedCiteKeySet.add(lowerEmit);
        emittedEntries.push({ item: it, emitCiteKey: emitKey });
      }
    }

    for (const alias of aliases) {
      const lowerAlias = alias.toLowerCase();
      if (
        keySet.has(lowerAlias) &&
        lowerAlias !== primaryCiteKey.toLowerCase() &&
        lowerAlias !== itemId.toLowerCase()
      ) {
        const requestedKey = originalKeyByLower.get(lowerAlias) || alias;
        foundKeys.push(requestedKey);
        if (!emittedCiteKeySet.has(lowerAlias)) {
          emittedCiteKeySet.add(lowerAlias);
          emittedEntries.push({ item: it, emitCiteKey: requestedKey });
        }
      } else if (
        !itemMatchedPrimary &&
        keySet.has(lowerAlias) &&
        !emittedCiteKeySet.has(lowerAlias)
      ) {
        const requestedKey = originalKeyByLower.get(lowerAlias) || alias;
        foundKeys.push(requestedKey);
        emittedCiteKeySet.add(lowerAlias);
        emittedEntries.push({ item: it, emitCiteKey: requestedKey });
      }
    }
  }

  const foundKeySet = new Set(foundKeys.map((k: string) => k.toLowerCase()));
  const missingKeys = trimmedKeys.filter(
    (k) => !foundKeySet.has(k.trim().toLowerCase()),
  );

  return {
    foundKeys,
    missingKeys,
    emittedEntries,
  };
}
