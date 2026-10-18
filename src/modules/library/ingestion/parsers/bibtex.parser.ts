import { Injectable, Logger } from '@nestjs/common';
import {
  ParsedBibtexEntry,
  CslItem,
  buildParsedBibtexEntry,
  cleanBibtexField,
} from './bibtex-entry.builder';
import {
  BibtexFallbackParser,
  extractBibtexFields,
} from './bibtex-fallback.parser';

export {
  type ParsedBibtexEntry,
  type BibtexItem,
  type CslItem,
  type CslPerson,
  buildParsedBibtexEntry,
  cleanBibtexField,
  mapBibtexTypeToItemType,
} from './bibtex-entry.builder';

export {
  BibtexFallbackParser,
  extractBibtexFields,
} from './bibtex-fallback.parser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core') as {
  Cite: new (input: string) => { data?: CslItem[] };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-bibtex');

@Injectable()
export class BibtexParser {
  private readonly logger = new Logger(BibtexParser.name);

  /**
   * Parse a raw BibTeX string asynchronously using in-process @citation-js.
   */
  parseAsync(rawBibtex: string): Promise<ParsedBibtexEntry[]> {
    if (!rawBibtex || typeof rawBibtex !== 'string' || !rawBibtex.trim()) {
      return Promise.resolve([]);
    }
    return Promise.resolve(this.parse(rawBibtex));
  }

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

      // Pre-scan raw BibTeX entries by citationKey and index so we can enrich fields
      // that @citation-js/plugin-bibtex drops (e.g. eprint, archivePrefix, file, raw entry type).
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
        const extractedFields = extractBibtexFields(rawMatch[3] || '');
        const entryInfo = {
          rawType: rType,
          citationKey: cKey,
          fields: extractedFields,
        };
        rawEntriesByIndex.push(entryInfo);
        if (cKey) {
          rawEntriesByKey.set(cKey.toLowerCase(), entryInfo);
        }
      }

      return data.map((csl: CslItem, idx: number) => {
        const citationKey = csl['citation-key'] || csl.id || undefined;
        const rawEntry =
          (citationKey
            ? rawEntriesByKey.get(String(citationKey).toLowerCase())
            : undefined) || rawEntriesByIndex[idx];
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

  /**
   * Resilient regex fallback for non-standard BibTeX dialects
   */
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
