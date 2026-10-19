import {
  ClassifiedQuery,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  stripSurroundingPunctuation,
  normalizeArxivId,
  normalizePmcid,
  normalizeDoi,
  normalizePmid,
  normalizeIsbn,
} from '@/modules/library/core';

export class QueryClassifier {
  private static readonly GENERIC_URL_REGEX = /^https?:\/\/[^\s$.?#].[^\s]*$/i;

  static classify(rawQuery: string): ClassifiedQuery {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return { raw: '', clean: '', type: 'TITLE' };
    }

    const trimmed = rawQuery.trim();
    const candidate = stripSurroundingPunctuation(trimmed);

    // 1. arXiv (URLs, arXiv IDs, and 10.48550/arXiv.* DOIs)
    const normalizedArxiv = normalizeArxivId(candidate);
    if (normalizedArxiv) {
      return { raw: trimmed, clean: normalizedArxiv, type: 'ARXIV' };
    }

    // 2. PubMed Central (PMC URLs or bare PMCID)
    const normalizedPmc = normalizePmcid(candidate);
    if (normalizedPmc && /^(?:pmc|https?:\/\/)/i.test(candidate)) {
      return { raw: trimmed, clean: normalizedPmc, type: 'PMID' };
    }

    // 3. DOIs (including Nature, Zenodo, BioRxiv/MedRxiv, PLOS, embedded publisher URLs, doi.org, and bare 10.xxxx/...)
    if (
      /^(?:https?:\/\/|doi:\s*|10\.\d{4,9}\/)/i.test(candidate) &&
      !/^10\.48550\/arxiv\./i.test(candidate)
    ) {
      const normalizedDoi = normalizeDoi(candidate);
      if (normalizedDoi) {
        return { raw: trimmed, clean: normalizedDoi, type: 'DOI' };
      }
    }

    // 4. PubMed (pubmed.ncbi.nlm.nih.gov/... or pmid:... or bare 1-9 digit numeric ID)
    const normalizedPmid = normalizePmid(candidate);
    if (normalizedPmid) {
      return { raw: trimmed, clean: normalizedPmid, type: 'PMID' };
    }

    // 5. ISBN (including ISBN-10 and ISBN-13 with optional prefix)
    const normalizedIsbn = normalizeIsbn(candidate);
    if (normalizedIsbn) {
      return { raw: trimmed, clean: normalizedIsbn, type: 'ISBN' };
    }

    // 6. Generic URL
    if (this.GENERIC_URL_REGEX.test(candidate)) {
      return { raw: trimmed, clean: candidate, type: 'URL' };
    }

    // 7. Default: Title or keyword search
    return { raw: trimmed, clean: trimmed, type: 'TITLE' };
  }

  /**
   * Splits and classifies a Zotero "Add Item by Identifier" batch input string
   * containing multiple space-, comma-, or newline-separated identifiers (DOIs, ISBNs, PMIDs, arXiv IDs).
   */
  static classifyBatch(rawInput: string): ClassifiedQuery[] {
    if (!rawInput || typeof rawInput !== 'string') return [];
    const lines = rawInput
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const results: ClassifiedQuery[] = [];

    for (const line of lines) {
      const single = this.classify(line);
      if (single.type !== 'TITLE') {
        results.push(single);
        continue;
      }
      // Try splitting space/comma/semicolon separated tokens if the line contains multiple identifiers
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

export type { QueryType, ClassifiedQuery };
