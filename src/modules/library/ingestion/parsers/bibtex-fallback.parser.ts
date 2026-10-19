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

  while (pos < len) {
    const keyMatch = body.slice(pos).match(/^\s*([a-zA-Z_-]+)\s*=\s*/);
    if (!keyMatch) {
      pos++;
      continue;
    }

    const key = keyMatch[1].toLowerCase();
    pos += keyMatch[0].length;

    if (pos >= len) break;

    const shouldExtract = !allowedKeys || allowedKeys.has(key);
    const char = body[pos];
    let value = '';

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
        value = body.slice(start, depth === 0 ? pos - 1 : pos);
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
        value = body.slice(start, pos);
      }
      if (pos < len && body[pos] === '"') pos++;
    } else {
      const bareMatch = body.slice(pos).match(/^([^,\n}\s]+)/);
      if (bareMatch) {
        if (shouldExtract) {
          value = bareMatch[1];
        }
        pos += bareMatch[0].length;
      }
    }

    if (shouldExtract) {
      fields[key] = value.trim();
    }

    const commaMatch = body.slice(pos).match(/^\s*,\s*/);
    if (commaMatch) {
      pos += commaMatch[0].length;
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
