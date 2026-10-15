/**
 * citations/domain/bibtex.formatter.ts
 * Pure domain BibTeX escaping, value formatting, library-item serialization,
 * and zero-dependency AST/Regex BibTeX parser & formatter.
 */

import { IBibtexParserPort } from '../core/ports/bibtex-parser.port';
import { BibEntry } from '../core/domain/entities/bib-entry.entity';
import { CitationKeyVo } from '../core/domain/value-objects/citation-key.vo';

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

/**
 * Escape LaTeX special characters in a plain-text string.
 */
export function escapeLatex(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\textbackslash{}';
        break;
      case '{':
        out += '\\{';
        break;
      case '}':
        out += '\\}';
        break;
      case '$':
        out += '\\$';
        break;
      case '&':
        out += '\\&';
        break;
      case '%':
        out += '\\%';
        break;
      case '#':
        out += '\\#';
        break;
      case '_':
        out += '\\_';
        break;
      case '~':
        out += '\\textasciitilde{}';
        break;
      case '^':
        out += '\\textasciicircum{}';
        break;
      default:
        out += ch;
    }
  }
  return out;
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

  if (NAME_FIELDS.has(field)) {
    return str
      .split(/\s+and\s+/)
      .map((name) => {
        const literal = name.match(/^\{(.*)\}$/);
        return literal ? `{${escapeLatex(literal[1])}}` : escapeLatex(name);
      })
      .join(' and ');
  }

  const escaped = escapeLatex(str);
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
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_:.-]/g, '');
}

export interface DbContributor {
  orderIndex?: number | null;
  lastName?: string | null;
  firstName?: string | null;
  fullName?: string | null;
  fieldMode?: number | null;
  creatorType?: string | null;
}

export interface DbLibraryItem {
  id: string;
  itemType?: string | null;
  citationKey?: string | null;
  title?: string | null;
  publicationTitle?: string | null;
  year?: number | string | null;
  doi?: string | null;
  url?: string | null;
  metadata?: unknown;
  contributors?: DbContributor[];
}

function collectMetadata(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const add = (obj: unknown) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      const key = k.toLowerCase();
      if (!(key in out)) out[key] = v;
    }
  };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    add(raw);
    add((raw as Record<string, unknown>).extraFields);
  }
  return out;
}

function extractArxivId(
  archiveId?: string | null,
  doi?: string | null,
  url?: string | null,
): string | undefined {
  const fromArchive = archiveId?.match(/^(?:arxiv:)?\s*(\S+)$/i)?.[1];
  if (
    archiveId &&
    /arxiv/i.test(archiveId) &&
    fromArchive &&
    /\d/.test(fromArchive)
  ) {
    return fromArchive;
  }
  if (archiveId && /^\d{4}\.\d{4,5}(v\d+)?$/.test(archiveId)) return archiveId;
  const fromDoi = doi?.match(/10\.48550\/arxiv\.(.+)$/i)?.[1];
  if (fromDoi) return fromDoi;
  const fromUrl = url?.match(
    /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i,
  )?.[1];
  return fromUrl || undefined;
}

/**
 * Serializes a Flux library item (Zotero-schema item types + metadata JSON)
 * into a BibTeX entry string. All values are escaped through toBibtexValue().
 */
export function formatLibraryItemToBibtex(item: DbLibraryItem): string {
  const meta = collectMetadata(item.metadata);
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = meta[k.toLowerCase()];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        return String(v).trim();
      }
    }
    return undefined;
  };

  const itemType = item.itemType || 'journalArticle';
  const container = item.publicationTitle || get('publicationTitle');
  const fields: Array<[string, string | undefined]> = [];
  let bibType = 'misc';

  const contributors = [...(item.contributors || [])].sort(
    (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
  );
  const SECONDARY_ROLES = new Set([
    'editor',
    'serieseditor',
    'translator',
    'bookauthor',
    'reviewedauthor',
    'contributor',
    'commenter',
  ]);
  const nameOf = (c: DbContributor) =>
    formatBibtexName({
      lastName: c.lastName || (c.fieldMode === 1 ? c.fullName : null),
      firstName: c.firstName,
      fieldMode: c.fieldMode,
    }) || (c.fullName ? escapeLatex(c.fullName.trim()) : '');
  const authors = contributors
    .filter(
      (c) => !SECONDARY_ROLES.has((c.creatorType || 'author').toLowerCase()),
    )
    .map(nameOf)
    .filter(Boolean)
    .join(' and ');
  const editors = contributors
    .filter((c) => (c.creatorType || '').toLowerCase() === 'editor')
    .map(nameOf)
    .filter(Boolean)
    .join(' and ');

  switch (itemType) {
    case 'journalArticle':
    case 'magazineArticle':
    case 'newspaperArticle':
      bibType = 'article';
      fields.push(['journal', container]);
      break;
    case 'conferencePaper':
      bibType = 'inproceedings';
      fields.push([
        'booktitle',
        get('proceedingsTitle') || container || get('conferenceName'),
      ]);
      fields.push(['publisher', get('publisher')]);
      fields.push(['address', get('place')]);
      break;
    case 'book':
      bibType = 'book';
      fields.push(['publisher', get('publisher')]);
      fields.push(['address', get('place')]);
      fields.push(['edition', get('edition')]);
      fields.push(['series', get('series')]);
      break;
    case 'bookSection':
      bibType = 'incollection';
      fields.push(['booktitle', get('bookTitle') || container]);
      fields.push(['publisher', get('publisher')]);
      fields.push(['address', get('place')]);
      fields.push(['edition', get('edition')]);
      fields.push(['series', get('series')]);
      break;
    case 'thesis': {
      const thesisType = get('thesisType', 'type') || '';
      bibType = /master|magister|\bm\.?\s?(?:sc|a|s|eng|phil)\b/i.test(
        thesisType,
      )
        ? 'mastersthesis'
        : 'phdthesis';
      fields.push(['school', get('university', 'institution', 'publisher')]);
      fields.push(['address', get('place')]);
      break;
    }
    case 'report':
      bibType = 'techreport';
      fields.push([
        'institution',
        get('institution', 'publisher') || container,
      ]);
      fields.push(['number', get('reportNumber', 'number')]);
      fields.push(['type', get('reportType')]);
      fields.push(['address', get('place')]);
      break;
    case 'preprint': {
      bibType = 'misc';
      const arxivId = extractArxivId(
        get('arxivId', 'archiveID', 'archiveId'),
        item.doi,
        item.url,
      );
      if (arxivId) {
        fields.push(['eprint', arxivId]);
        fields.push(['archiveprefix', 'arXiv']);
        fields.push(['primaryclass', get('primaryClass', 'primaryCategory')]);
      } else {
        fields.push(['howpublished', get('repository') || container]);
      }
      break;
    }
    case 'webpage':
    case 'blogPost':
    case 'forumPost':
      bibType = 'misc';
      fields.push(['howpublished', get('websiteTitle') || container]);
      break;
    default:
      bibType = 'misc';
      fields.push(['howpublished', container]);
      fields.push(['publisher', get('publisher')]);
      break;
  }

  const pages = get('pages');
  const accessDate = get('accessDate');
  const common: Array<[string, string | undefined]> = [
    ['volume', get('volume')],
    ['number', itemType === 'report' ? undefined : get('issue')],
    [
      'pages',
      pages ? pages.replace(/\s*[-\u2010-\u2015]+\s*/g, '--') : undefined,
    ],
    ['year', item.year != null ? String(item.year) : get('year')],
    ['issn', get('ISSN')],
    ['isbn', get('ISBN')],
    ['doi', item.doi || get('DOI')],
    ['url', item.url || get('url')],
    [
      'urldate',
      accessDate && /^\d{4}-\d{2}-\d{2}/.test(accessDate)
        ? accessDate.slice(0, 10)
        : undefined,
    ],
  ];

  const citeKey =
    sanitizeCitationKey(item.citationKey || '') ||
    `item_${item.id.replace(/-/g, '').substring(0, 8)}`;

  const lines: string[] = [];
  if (authors) lines.push(`  author = {${authors}}`);
  if (editors) lines.push(`  editor = {${editors}}`);
  const title = toBibtexValue(item.title, { field: 'title' });
  if (title) lines.push(`  title = {${title}}`);

  const seen = new Set<string>(['author', 'editor', 'title']);
  for (const [name, raw] of [...fields, ...common]) {
    if (seen.has(name)) continue;
    const value = toBibtexValue(raw, { field: name });
    if (!value) continue;
    seen.add(name);
    lines.push(`  ${name} = {${value}}`);
  }

  return `@${bibType}{${citeKey},\n${lines.join(',\n')}\n}`;
}
