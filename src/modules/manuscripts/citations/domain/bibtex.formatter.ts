/**
 * citations/domain/bibtex.formatter.ts
 * Pure domain BibTeX escaping, value formatting, and library-item serialization.
 */

import { escapeLatex } from '@/modules/manuscripts/core';

export { escapeLatex };

/** Fields whose content is read verbatim by BibTeX/biblatex and must NOT be escaped. */
const VERBATIM_FIELDS = new Set([
  'url',
  'doi',
  'eprint',
  'file',
  'pdf',
  'urldate',
]);

/** Name-list fields ("Last, First and {Org}"). */
const NAME_FIELDS = new Set(['author', 'editor', 'translator', 'bookauthor']);

/** Fields where capitalization should be protected. */
const TITLE_FIELDS = new Set([
  'title',
  'booktitle',
  'journal',
  'journaltitle',
  'series',
  'shorttitle',
  'maintitle',
  'subtitle',
]);

export interface ToBibtexValueOptions {
  /** BibTeX field name (case-insensitive). Determines escaping / casing rules. */
  field?: string;
}

function needsCaseProtection(word: string): boolean {
  const letters = word.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return false;
  return /\p{Lu}/u.test(letters.slice(1));
}

function protectCapitalization(escaped: string): string {
  return escaped
    .split(/(\s+)/)
    .map((token) => {
      if (!token || /^\s+$/.test(token)) return token;
      if (token.includes('\\') || token.includes('{') || token.includes('}')) {
        return token;
      }
      const m = token.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
      if (!m) return token;
      const [, lead, core, trail] = m;
      if (core && needsCaseProtection(core)) {
        return `${lead}{${core}}${trail}`;
      }
      return token;
    })
    .join('');
}

function balanceBraces(value: string): string {
  let depth = 0;
  let out = '';
  for (const ch of value) {
    if (ch === '{') {
      depth++;
      out += ch;
    } else if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out + '}'.repeat(depth);
}

/**
 * Convert a plain-text metadata value into a BibTeX-safe field body
 * (the content placed between the outer braces: `field = {<here>}`).
 */
export function toBibtexValue(
  value: unknown,
  options: ToBibtexValueOptions = {},
): string {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\s+/g, ' ').trim();
  if (!str) return '';

  const field = (options.field || '').toLowerCase();

  if (VERBATIM_FIELDS.has(field)) {
    return balanceBraces(str);
  }

  const normalizedStr = str.replace(/([A-Za-z0-9])\s*[–—]\s*([A-Za-z0-9])/g, '$1--$2');

  if (field === 'pages' || field === 'page') {
    const normalizedPages = normalizedStr.replace(/\s*[–—]\s*/g, '--');
    return escapeLatex(normalizedPages);
  }

  if (NAME_FIELDS.has(field)) {
    return normalizedStr
      .split(/\s+and\s+/)
      .map((name) => {
        const literal = name.match(/^\{(.*)\}$/);
        return literal ? `{${escapeLatex(literal[1])}}` : escapeLatex(name);
      })
      .join(' and ');
  }

  const escaped = escapeLatex(normalizedStr);
  if (TITLE_FIELDS.has(field)) {
    return protectCapitalization(escaped);
  }
  return escaped;
}

/**
 * Format a single BibTeX name. Organizations / single-field names are wrapped
 * in braces ({World Health Organization}) so BibTeX treats them as a literal.
 */
export function formatBibtexName(name: {
  lastName?: string | null;
  firstName?: string | null;
  fieldMode?: number | null;
}): string {
  const last = (name.lastName || '').trim();
  const first = (name.firstName || '').trim();
  if (name.fieldMode === 1) {
    const literal = last || first;
    return literal ? `{${escapeLatex(literal)}}` : '';
  }
  if (last && first) return `${escapeLatex(last)}, ${escapeLatex(first)}`;
  return escapeLatex(last || first);
}

/**
 * Sanitize an arbitrary string into a valid citation key ([A-Za-z0-9_:.-]).
 */
export function sanitizeCitationKey(raw: string): string {
  return raw
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_:.-]/g, '');
}
