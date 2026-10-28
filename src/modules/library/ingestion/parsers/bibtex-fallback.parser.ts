import {
  ParsedBibtexEntry,
  buildParsedBibtexEntry,
} from './bibtex-entry.builder';

/**
 * Custom and non-standard BibTeX keys that @citation-js/plugin-bibtex either drops,
 * alters (e.g. stripping math/braces or corporate authors), or fails to map into CSL.
 */
export const CUSTOM_BIBTEX_ENRICHMENT_KEYS = new Set<string>([
  'archiveprefix',
  'eprint',
  'primaryclass',
  'lccn',
  'mrnumber',
  'zbl',
  'arxiv',
  'arxivid',
  'pmid',
  'pmcid',
  'file',
  'pdf',
  'school',
  'university',
  'institution',
  'organization',
  'type',
  'number',
  'booktitle',
  'journaltitle',
  'eventtitle',
  'conference',
  'venue',
  'eventplace',
  'location',
  'address',
  'place',
  'series',
  'series_title',
  'numpages',
  'pagetotal',
  'volumes',
  'chapter',
  'shorttitle',
  'shortjournal',
  'fjournal',
  'urldate',
  'accessed',
  'keywords',
  'keyword',
  'tags',
  'note',
  'annote',
  'comment',
  'rights',
  'license',
  'author',
  'editor',
  'title',
  'date',
  'issue',
]);

export function extractBibtexFields(
  body: string,
  allowedKeys?: ReadonlySet<string>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  let pos = 0;
  const len = body.length;

  const keyStickyRe = /\s*([a-zA-Z0-9_:-]+)\s*=\s*/y;
  const keySearchRe = /([a-zA-Z0-9_:-]+)\s*=\s*/g;
  const wsStickyRe = /\s+/y;
  const bareStickyRe = /([^,\n}#\s]+)/y;
  const concatStickyRe = /\s*#\s*/y;
  const commaStickyRe = /\s*,\s*/y;

  while (pos < len) {
    keyStickyRe.lastIndex = pos;
    let keyMatch = keyStickyRe.exec(body);
    if (!keyMatch) {
      keySearchRe.lastIndex = pos;
      keyMatch = keySearchRe.exec(body);
      if (!keyMatch) break;
      pos = keySearchRe.lastIndex;
    } else {
      pos = keyStickyRe.lastIndex;
    }

    const key = keyMatch[1].toLowerCase();
    if (pos >= len) break;

    const shouldExtract = !allowedKeys || allowedKeys.has(key);
    const segments: string[] = [];

    while (pos < len) {
      wsStickyRe.lastIndex = pos;
      if (wsStickyRe.exec(body)) {
        pos = wsStickyRe.lastIndex;
      }
      if (pos >= len) break;

      const char = body[pos];
      if (char === '{') {
        pos++;
        let depth = 1;
        const start = pos;
        while (pos < len && depth > 0) {
          if (body[pos] === '\\') {
            pos += 2;
            continue;
          }
          if (body[pos] === '{') depth++;
          else if (body[pos] === '}') depth--;
          pos++;
        }
        if (shouldExtract) {
          segments.push(body.slice(start, depth === 0 ? pos - 1 : pos));
        }
      } else if (char === '"') {
        pos++;
        const start = pos;
        while (pos < len && body[pos] !== '"') {
          if (body[pos] === '\\') {
            pos += 2;
            continue;
          }
          pos++;
        }
        if (shouldExtract) {
          segments.push(body.slice(start, pos));
        }
        if (pos < len && body[pos] === '"') pos++;
      } else {
        bareStickyRe.lastIndex = pos;
        const bareMatch = bareStickyRe.exec(body);
        if (bareMatch) {
          if (shouldExtract) {
            segments.push(bareMatch[1]);
          }
          pos = bareStickyRe.lastIndex;
        } else {
          break;
        }
      }

      concatStickyRe.lastIndex = pos;
      if (concatStickyRe.exec(body)) {
        pos = concatStickyRe.lastIndex;
        continue;
      }
      break;
    }

    if (shouldExtract) {
      fields[key] = segments.join('').trim();
    }

    commaStickyRe.lastIndex = pos;
    if (commaStickyRe.exec(body)) {
      pos = commaStickyRe.lastIndex;
    }
  }

  return fields;
}

export class BibtexFallbackParser {
  /**
   * Resilient regex fallback for non-standard BibTeX dialects
   */
  static parse(rawBibtex: string): ParsedBibtexEntry[] {
    const entries: ParsedBibtexEntry[] = [];
    const entryRegex =
      /@([a-zA-Z]+)\s*\{\s*([^,\s]*)\s*,([\s\S]*?)(?=\n\s*@[a-zA-Z]+\s*\{|\s*$)/g;

    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(rawBibtex)) !== null) {
      const rawType = match[1].toLowerCase();
      if (
        rawType === 'comment' ||
        rawType === 'preamble' ||
        rawType === 'string'
      ) {
        continue;
      }

      const citationKey = match[2]?.trim() || '';
      const body = match[3] || '';
      const fields = extractBibtexFields(body);
      entries.push(
        buildParsedBibtexEntry(citationKey || undefined, rawType, fields),
      );
    }

    return entries;
  }
}
