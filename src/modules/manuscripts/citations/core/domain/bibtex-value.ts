/**
 * citations/core/domain/utils/bibtex-value.utils.ts
 * Shared helpers for serializing plain-text metadata into safe BibTeX field values.
 *
 * - Escapes LaTeX special characters (\ { } $ & % # _ ~ ^) for regular fields.
 * - Leaves verbatim fields (url, doi, eprint, file...) untouched apart from
 *   brace balancing, since biblatex/hyperref read them verbatim.
 * - Protects capitalization in title-like fields (Better BibTeX style): words
 *   with internal capitals or all-caps acronyms (BERT, iPhone, mRNA, DNA) are
 *   wrapped in {} so BibTeX styles do not lowercase them.
 */

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

/**
 * Returns true when a word should have its capitalization protected:
 * - contains an uppercase letter after the first character (iPhone, mRNA, McDonald, BERT)
 * - or is an all-caps token of length >= 2 (DNA, NLP).
 */
function needsCaseProtection(word: string): boolean {
  const letters = word.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return false;
  return /\p{Lu}/u.test(letters.slice(1));
}

/**
 * Wrap case-sensitive words in braces. Expects already-escaped input; only
 * splits on whitespace so escape sequences remain intact.
 */
function protectCapitalization(escaped: string): string {
  return escaped
    .split(/(\s+)/)
    .map((token) => {
      if (!token || /^\s+$/.test(token)) return token;
      // Do not wrap tokens containing LaTeX commands / braces (already escaped specials)
      if (token.includes('\\') || token.includes('{') || token.includes('}')) {
        return token;
      }
      // Separate leading/trailing punctuation so it stays outside the braces
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

/**
 * Balance braces in verbatim fields by dropping unmatched closing braces and
 * closing dangling opening braces; prevents a malformed URL from breaking the entry.
 */
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
    // "A and B" name lists: keep a fully-braced name ({World Health Organization})
    // as a literal group, escape everything else.
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
 * in double braces ({{World Health Organization}}) so BibTeX treats them as a literal.
 */
export function formatBibtexName(name: {
  lastName?: string | null;
  firstName?: string | null;
  fieldMode?: number | null;
}): string {
  const last = (name.lastName || '').trim();
  const first = (name.firstName || '').trim();
  if (name.fieldMode === 1) {
    // Single-field names (organizations) are protected as a literal unit.
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
