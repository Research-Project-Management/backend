import { Injectable, Logger } from '@nestjs/common';
import {
  ClassifiedQuery,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import { IngestionValidationException } from '@/modules/library/ingestion/types/ingestion.errors';
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

      const entryRegex =
        /@([a-zA-Z]+)\s*\{\s*([^,\s]*)\s*,([\s\S]*?)(?=\n\s*@[a-zA-Z]+\s*\{|\s*$)/g;
      let rawMatch: RegExpExecArray | null;
      while ((rawMatch = entryRegex.exec(rawBibtex)) !== null) {
        const rType = rawMatch[1].toLowerCase();
        if (rType === 'comment' || rType === 'preamble' || rType === 'string') {
          continue;
        }
        const cKey = rawMatch[2]?.trim() || '';
        const extractedFields = extractBibtexFields(
          rawMatch[3] || '',
          CUSTOM_BIBTEX_ENRICHMENT_KEYS,
        );
        const entryInfo = {
          rawType: rType,
          citationKey: cKey,
          fields: extractedFields,
        };
        rawEntriesByIndex.push(entryInfo);
        if (cKey && !rawEntriesByKey.has(cKey.toLowerCase())) {
          rawEntriesByKey.set(cKey.toLowerCase(), entryInfo);
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
