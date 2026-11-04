import { Injectable, Logger } from '@nestjs/common';
import {
  ClassifiedQuery,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import { IngestionValidationException } from '@/modules/library/ingestion/types/metadata.types';
import {
  stripSurroundingPunctuation,
  normalizeArxivId,
  normalizePmcid,
  normalizeDoi,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/core';
import {
  ParsedBibtexEntry,
  CslItem,
  buildParsedBibtexEntry,
  cleanBibtexField,
} from './bibtex-entry.builder';

export {
  type ParsedBibtexEntry,
  type BibtexItem,
  type CslItem,
  type CslPerson,
  buildParsedBibtexEntry,
  cleanBibtexField,
  mapBibtexTypeToItemType,
} from './bibtex-entry.builder';
export type { QueryType, ClassifiedQuery };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core') as {
  Cite: new (input: string) => { data?: CslItem[] };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-bibtex');

/**
 * Custom and non-standard BibTeX keys that @citation-js/plugin-bibtex either drops,
 * alters (e.g. stripping math/braces or corporate authors), or fails to map into CSL.
 */
export const CUSTOM_BIBTEX_ENRICHMENT_KEYS = new Set<string>([
  'abstract',
  'archiveprefix',
  'eprint',
  'primaryclass',
  'lccn',
  'mrnumber',
  'zbl',
  'arxiv',
  'arxivid',
  'doi',
  'isbn',
  'issn',
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
  'pages',
  'eid',
  'numpages',
  'pagetotal',
  'volume',
  'volumes',
  'chapter',
  'shorttitle',
  'subtitle',
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
  'translator',
  'title',
  'date',
  'issue',
  'journal',
  'publisher',
  'month',
]);

export const DEFAULT_BIBTEX_STRING_MACROS: Readonly<Record<string, string>> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
  acmcs: 'ACM Computing Surveys',
  acta: 'Acta Informatica',
  cacm: 'Communications of the ACM',
  ibmjrd: 'IBM Journal of Research and Development',
  ibmsj: 'IBM Systems Journal',
  ieeese: 'IEEE Transactions on Software Engineering',
  ieeetc: 'IEEE Transactions on Computers',
  ieeetcad:
    'IEEE Transactions on Computer-Aided Design of Integrated Circuits',
  ipl: 'Information Processing Letters',
  jacm: 'Journal of the ACM',
  jcss: 'Journal of Computer and System Sciences',
  scp: 'Science of Computer Programming',
  sicomp: 'SIAM Journal on Computing',
  tocs: 'ACM Transactions on Computer Systems',
  tods: 'ACM Transactions on Database Systems',
  tog: 'ACM Transactions on Graphics',
  toms: 'ACM Transactions on Mathematical Software',
  toois: 'ACM Transactions on Office Information Systems',
  toplas: 'ACM Transactions on Programming Languages and Systems',
  tcs: 'Theoretical Computer Science',
};

export function extractBibtexFields(
  body: string,
  allowedKeys?: ReadonlySet<string>,
  macros?: ReadonlyMap<string, string>,
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
    // Skip whitespace and '%' comments before looking for next key
    while (pos < len) {
      const ch = body[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        pos++;
      } else if (ch === '%') {
        while (pos < len && body[pos] !== '\n' && body[pos] !== '\r') {
          pos++;
        }
      } else {
        break;
      }
    }
    if (pos >= len) break;

    keyStickyRe.lastIndex = pos;
    let keyMatch = keyStickyRe.exec(body);
    if (!keyMatch) {
      // Advance to next line or delimiter
      while (
        pos < len &&
        body[pos] !== '\n' &&
        body[pos] !== '\r' &&
        body[pos] !== ','
      ) {
        pos++;
      }
      if (pos < len && body[pos] === ',') pos++;
      continue;
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
        let braceDepth = 0;
        const start = pos;
        while (pos < len) {
          if (body[pos] === '\\') {
            pos += 2;
            continue;
          }
          if (body[pos] === '{') {
            braceDepth++;
          } else if (body[pos] === '}') {
            if (braceDepth > 0) braceDepth--;
          } else if (body[pos] === '"' && braceDepth === 0) {
            break;
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
            const rawToken = bareMatch[1];
            const lowerToken = rawToken.toLowerCase();
            const expanded =
              macros?.get(lowerToken) ??
              DEFAULT_BIBTEX_STRING_MACROS[lowerToken] ??
              rawToken;
            segments.push(expanded);
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

export function extractBibtexStringMacros(
  rawBibtex: string,
): Map<string, string> {
  const macros = new Map<string, string>(
    Object.entries(DEFAULT_BIBTEX_STRING_MACROS),
  );
  if (!rawBibtex) return macros;

  const headerRe = /@string\s*([{(])/gi;
  let match: RegExpExecArray | null;

  while ((match = headerRe.exec(rawBibtex)) !== null) {
    const openChar = match[1];
    const closeChar = openChar === '{' ? '}' : ')';
    let pos = headerRe.lastIndex;
    const len = rawBibtex.length;
    let depth = 1;
    let inQuotes = false;

    const contentStart = pos;
    while (pos < len && depth > 0) {
      const ch = rawBibtex[pos];
      if (ch === '\\') {
        pos += 2;
        continue;
      }
      if (ch === '%' && !inQuotes && depth <= 1) {
        // Skip comment line
        while (pos < len && rawBibtex[pos] !== '\n' && rawBibtex[pos] !== '\r') {
          pos++;
        }
        continue;
      }
      if (ch === '"') {
        if (depth === 1) {
          inQuotes = !inQuotes;
        }
      } else {
        if (ch === openChar || ch === '{') {
          depth++;
        } else if (ch === closeChar || ch === '}') {
          if (depth > 1) {
            depth--;
          } else if (depth === 1 && !inQuotes) {
            depth--;
          }
        }
      }
      pos++;
    }

    const innerContent = rawBibtex.slice(
      contentStart,
      depth === 0 ? pos - 1 : pos,
    );
    headerRe.lastIndex = pos;

    const parsed = extractBibtexFields(innerContent, undefined, macros);
    for (const [k, v] of Object.entries(parsed)) {
      macros.set(k.toLowerCase(), v);
    }
  }

  return macros;
}

export interface RawBibtexBlock {
  rawType: string;
  citationKey: string;
  body: string;
}

/**
 * Splits a raw BibTeX string into balanced `@type{key, body}` or `@type(key, body)` blocks in O(N) time.
 * Immune to `@` characters inside field values (e.g. emails or abstracts) and supports multiple entries on a single line.
 */
export function splitBibtexEntryBlocks(rawBibtex: string): RawBibtexBlock[] {
  const blocks: RawBibtexBlock[] = [];
  const headerRe = /@([a-zA-Z]+)\s*([{(])/g;
  let match: RegExpExecArray | null;

  while ((match = headerRe.exec(rawBibtex)) !== null) {
    const rawType = match[1].toLowerCase();
    const openChar = match[2];
    const closeChar = openChar === '{' ? '}' : ')';
    let pos = headerRe.lastIndex;
    const len = rawBibtex.length;
    let depth = 1;
    let inQuotes = false;

    const contentStart = pos;
    while (pos < len && depth > 0) {
      const ch = rawBibtex[pos];
      if (ch === '\\') {
        pos += 2;
        continue;
      }
      if (ch === '%' && !inQuotes && depth <= 1) {
        // Skip comment line
        while (pos < len && rawBibtex[pos] !== '\n' && rawBibtex[pos] !== '\r') {
          pos++;
        }
        continue;
      }
      if (ch === '"') {
        if (depth === 1) {
          inQuotes = !inQuotes;
        }
      } else {
        if (ch === openChar || ch === '{') {
          depth++;
        } else if (ch === closeChar || ch === '}') {
          if (depth > 1) {
            depth--;
          } else if (depth === 1 && !inQuotes) {
            depth--;
          }
        }
      }
      pos++;
    }

    const innerContent = rawBibtex.slice(
      contentStart,
      depth === 0 ? pos - 1 : pos,
    );
    headerRe.lastIndex = pos;

    if (
      rawType === 'comment' ||
      rawType === 'preamble' ||
      rawType === 'string'
    ) {
      continue;
    }

    const commaIdx = innerContent.indexOf(',');
    if (commaIdx === -1) continue;

    const citationKey = innerContent.slice(0, commaIdx).trim();
    const body = innerContent.slice(commaIdx + 1);
    blocks.push({ rawType, citationKey, body });
  }

  return blocks;
}

export class BibtexFallbackParser {
  /**
   * Resilient parser for non-standard BibTeX dialects
   */
  static parse(rawBibtex: string): ParsedBibtexEntry[] {
    const entries: ParsedBibtexEntry[] = [];
    const macros = extractBibtexStringMacros(rawBibtex);
    for (const block of splitBibtexEntryBlocks(rawBibtex)) {
      const fields = extractBibtexFields(block.body, undefined, macros);
      entries.push(
        buildParsedBibtexEntry(
          block.citationKey || undefined,
          block.rawType,
          fields,
        ),
      );
    }
    return entries;
  }
}

@Injectable()
export class BibtexParser {
  private readonly logger = new Logger(BibtexParser.name);

  /**
   * Parse a raw BibTeX string containing one or multiple entries using @citation-js engine.
   */
  parse(rawBibtex: string): ParsedBibtexEntry[] {
    if (!rawBibtex || typeof rawBibtex !== 'string' || !rawBibtex.trim()) {
      return [];
    }

    const macros = extractBibtexStringMacros(rawBibtex);

    try {
      const cite = new Cite(rawBibtex);
      const data: CslItem[] = cite.data || [];

      if (data.length === 0) {
        return this.fallbackParse(rawBibtex);
      }

      const rawEntriesByKey = new Map<
        string,
        { rawType: string; fields: Record<string, string> }
      >();
      const rawEntriesByIndex: Array<{
        rawType: string;
        citationKey: string;
        fields: Record<string, string>;
      }> = [];

      for (const block of splitBibtexEntryBlocks(rawBibtex)) {
        const extractedFields = extractBibtexFields(
          block.body,
          CUSTOM_BIBTEX_ENRICHMENT_KEYS,
          macros,
        );
        const entryInfo = {
          rawType: block.rawType,
          citationKey: block.citationKey,
          fields: extractedFields,
        };
        rawEntriesByIndex.push(entryInfo);
        if (
          block.citationKey &&
          !rawEntriesByKey.has(block.citationKey.toLowerCase())
        ) {
          rawEntriesByKey.set(block.citationKey.toLowerCase(), entryInfo);
        }
      }

      return data.map((csl: CslItem, idx: number) => {
        const citationKey = csl['citation-key'] || csl.id || undefined;
        const indexedRaw = rawEntriesByIndex[idx];
        const rawEntry =
          (indexedRaw &&
          (!citationKey ||
            !indexedRaw.citationKey ||
            indexedRaw.citationKey.toLowerCase() ===
              String(citationKey).toLowerCase())
            ? indexedRaw
            : undefined) ||
          (citationKey
            ? rawEntriesByKey.get(String(citationKey).toLowerCase())
            : undefined) ||
          indexedRaw;
        return buildParsedBibtexEntry(
          citationKey,
          rawEntry?.rawType || '',
          rawEntry?.fields || {},
          csl,
        );
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Citation.js BibTeX parser error: ${errMsg}. Attempting fallback parsing.`,
      );
      return this.fallbackParse(rawBibtex);
    }
  }

  fallbackParse(rawBibtex: string): ParsedBibtexEntry[] {
    return BibtexFallbackParser.parse(rawBibtex);
  }

  cleanBibtexField(text?: string): string {
    return cleanBibtexField(text);
  }

  extractBibtexFields(body: string): Record<string, string> {
    return extractBibtexFields(body);
  }
}

// ============================================================================
// DOI Parser & Query Classifier
// ============================================================================

@Injectable()
export class DoiParser {
  normalize(rawDoi: string): string {
    if (!rawDoi || typeof rawDoi !== 'string' || !rawDoi.trim()) {
      throw new IngestionValidationException('DOI must be a non-empty string');
    }

    const normalized = normalizeDoi(rawDoi);
    if (!normalized) {
      throw new IngestionValidationException(
        `Invalid DOI syntax format: "${rawDoi}"`,
      );
    }

    return normalized;
  }

  isValid(rawDoi: string): boolean {
    try {
      this.normalize(rawDoi);
      return true;
    } catch {
      return false;
    }
  }
}

export class QueryClassifier {
  private static readonly GENERIC_URL_REGEX = /^https?:\/\/[^\s$.?#].[^\s]*$/i;

  static classify(rawQuery: string): ClassifiedQuery {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return { raw: '', clean: '', type: 'TITLE' };
    }

    const trimmed = rawQuery.trim();
    const candidate = stripSurroundingPunctuation(trimmed);

    const normalizedArxiv = normalizeArxivId(candidate);
    if (normalizedArxiv) {
      return { raw: trimmed, clean: normalizedArxiv, type: 'ARXIV' };
    }

    const normalizedPmc = normalizePmcid(candidate);
    if (normalizedPmc && /^(?:pmc|https?:\/\/)/i.test(candidate)) {
      return { raw: trimmed, clean: normalizedPmc, type: 'PMID' };
    }

    if (
      /^(?:https?:\/\/|doi:\s*|10\.\d{4,9}\/)/i.test(candidate) &&
      !/^10\.48550\/arxiv\./i.test(candidate)
    ) {
      const normalizedDoi = normalizeDoi(candidate);
      if (normalizedDoi) {
        return { raw: trimmed, clean: normalizedDoi, type: 'DOI' };
      }
    }

    const normalizedPmid = normalizePmid(candidate);
    if (normalizedPmid) {
      return { raw: trimmed, clean: normalizedPmid, type: 'PMID' };
    }

    const normalizedIsbn = normalizeIsbn(candidate);
    if (normalizedIsbn) {
      return { raw: trimmed, clean: normalizedIsbn, type: 'ISBN' };
    }

    if (this.GENERIC_URL_REGEX.test(candidate)) {
      return { raw: trimmed, clean: candidate, type: 'URL' };
    }

    return { raw: trimmed, clean: trimmed, type: 'TITLE' };
  }

  static classifyBatch(rawInput: string): ClassifiedQuery[] {
    if (!rawInput || typeof rawInput !== 'string') return [];
    const lines = rawInput
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const results: ClassifiedQuery[] = [];

    for (const line of lines) {
      if (/[,;\t]/.test(line)) {
        const tokens = line
          .split(/[\s,;]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        const tokenClassified = tokens.map((t) => this.classify(t));
        if (
          tokenClassified.length > 1 &&
          tokenClassified.every((c) => c.type !== 'TITLE')
        ) {
          results.push(...tokenClassified);
          continue;
        }
      }

      const single = this.classify(line);
      if (single.type !== 'TITLE') {
        results.push(single);
        continue;
      }
      const tokens = line
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const tokenClassified = tokens.map((t) => this.classify(t));
      if (
        tokenClassified.length > 1 &&
        tokenClassified.every((c) => c.type !== 'TITLE')
      ) {
        results.push(...tokenClassified);
      } else {
        results.push(single);
      }
    }

    return results;
  }
}
