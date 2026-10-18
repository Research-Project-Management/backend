import {
  ClassifiedQuery,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';

export class QueryClassifier {
  private static readonly DOI_REGEX =
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)$/i;

  private static readonly ARXIV_REGEX =
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:\.pdf|\.html)?$/i;

  private static readonly PMC_REGEX =
    /^(?:https?:\/\/(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc\/articles\/|pmc:\s*)?(PMC\d+)\/?$/i;

  private static readonly PMID_REGEX =
    /^(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/|pmid:\s*)(\d{1,9})\/?$/i;

  private static readonly NATURE_REGEX =
    /^https?:\/\/(?:www\.)?nature\.com\/articles\/([a-z0-9._-]+)(?:[?#].*)?$/i;

  private static readonly ZENODO_REGEX =
    /^https?:\/\/zenodo\.org\/records?\/(\d+)(?:[?#].*)?$/i;

  private static readonly BIORXIV_MEDRXIV_REGEX =
    /^https?:\/\/(?:www\.)?(?:biorxiv|medrxiv)\.org\/content\/(10\.\d{4,9}\/[^?#\s]+?)(?:v\d+)?(?:\.full|\.abstract|\.pdf)?(?:[?#].*)?$/i;

  private static readonly PLOS_REGEX =
    /^https?:\/\/journals\.plos\.org\/[^/]+\/article\?(?:[^#]*&)?id=(10\.\d{4,9}\/[^&#\s]+)/i;

  private static readonly EMBEDDED_DOI_REGEX =
    /^https?:\/\/[^/]+(?:\/[^/]+)*\/(?:doi\/|article\/)(?:abs\/|full\/|epdf\/|pdf\/)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)(?:[?#].*)?$/i;

  private static readonly ISBN_REGEX =
    /^(?:isbn:?\s*|urn:isbn:)?(97[89][-\s]?(?:\d[-\s]?){9}\d|(?:\d[-\s]?){9}[\dX])$/i;

  private static readonly GENERIC_URL_REGEX = /^https?:\/\/[^\s$.?#].[^\s]*$/i;

  private static stripOuterPunctuation(input: string): string {
    let clean = input.trim();
    let prev = '';
    while (clean !== prev) {
      prev = clean;
      clean = clean.replace(/[.,;]+$/, '').trim();
      if (
        (clean.startsWith('(') && clean.endsWith(')')) ||
        (clean.startsWith('[') && clean.endsWith(']')) ||
        (clean.startsWith('<') && clean.endsWith('>')) ||
        (clean.startsWith('"') && clean.endsWith('"')) ||
        (clean.startsWith("'") && clean.endsWith("'"))
      ) {
        clean = clean.slice(1, -1).trim();
      }
      if (clean.endsWith(')') && !clean.includes('(')) {
        clean = clean.slice(0, -1).trim();
      }
      if (clean.endsWith(']') && !clean.includes('[')) {
        clean = clean.slice(0, -1).trim();
      }
      if (clean.startsWith('(') && !clean.includes(')')) {
        clean = clean.slice(1).trim();
      }
      if (clean.startsWith('[') && !clean.includes(']')) {
        clean = clean.slice(1).trim();
      }
    }
    return clean;
  }

  private static cleanDoiString(doi: string): string {
    return this.stripOuterPunctuation(doi);
  }

  static classify(rawQuery: string): ClassifiedQuery {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return { raw: '', clean: '', type: 'TITLE' };
    }

    const trimmed = rawQuery.trim();
    const candidate = this.stripOuterPunctuation(trimmed);

    // 1. arXiv (URLs, arXiv IDs, and 10.48550/arXiv.* DOIs)
    const arxivDoiMatch = candidate.match(
      /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.48550\/arxiv\.(\d{4}\.\d{4,5}(?:v\d+)?)$/i,
    );
    if (arxivDoiMatch && arxivDoiMatch[1]) {
      return { raw: trimmed, clean: arxivDoiMatch[1], type: 'ARXIV' };
    }

    const arxivMatch = candidate.match(this.ARXIV_REGEX);
    if (arxivMatch && arxivMatch[1]) {
      return { raw: trimmed, clean: arxivMatch[1], type: 'ARXIV' };
    }

    // 2. PubMed Central (PMC URLs or bare PMCID)
    const pmcMatch = candidate.match(this.PMC_REGEX);
    if (pmcMatch && pmcMatch[1]) {
      return { raw: trimmed, clean: pmcMatch[1].toUpperCase(), type: 'PMID' };
    }

    // 3. Nature Articles (nature.com/articles/<slug> -> 10.1038/<slug>)
    const natureMatch = candidate.match(this.NATURE_REGEX);
    if (natureMatch && natureMatch[1]) {
      return {
        raw: trimmed,
        clean: `10.1038/${this.cleanDoiString(natureMatch[1])}`,
        type: 'DOI',
      };
    }

    // 4. Zenodo Records (zenodo.org/records/<id> -> 10.5281/zenodo.<id>)
    const zenodoMatch = candidate.match(this.ZENODO_REGEX);
    if (zenodoMatch && zenodoMatch[1]) {
      return {
        raw: trimmed,
        clean: `10.5281/zenodo.${zenodoMatch[1]}`,
        type: 'DOI',
      };
    }

    // 5. BioRxiv / MedRxiv preprints
    const biorxivMatch = candidate.match(this.BIORXIV_MEDRXIV_REGEX);
    if (biorxivMatch && biorxivMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(biorxivMatch[1].replace(/v\d+$/, '')),
        type: 'DOI',
      };
    }

    // 6. PLOS Articles (journals.plos.org/.../article?id=...)
    const plosMatch = candidate.match(this.PLOS_REGEX);
    if (plosMatch && plosMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(decodeURIComponent(plosMatch[1])),
        type: 'DOI',
      };
    }

    // 7. Embedded DOI in publisher URLs (ACM, Wiley, Science, PNAS, Springer, OUP, etc.)
    const embeddedDoiMatch = candidate.match(this.EMBEDDED_DOI_REGEX);
    if (embeddedDoiMatch && embeddedDoiMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(embeddedDoiMatch[1]),
        type: 'DOI',
      };
    }

    // 8. Direct or doi.org DOIs
    const doiMatch = candidate.match(this.DOI_REGEX);
    if (doiMatch && doiMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(doiMatch[1]),
        type: 'DOI',
      };
    }

    // 9. PubMed (pubmed.ncbi.nlm.nih.gov/... or pmid:...)
    const pmidMatch = candidate.match(this.PMID_REGEX);
    if (pmidMatch && pmidMatch[1]) {
      return { raw: trimmed, clean: pmidMatch[1], type: 'PMID' };
    }

    // 10. Bare numeric ID: if 1-9 digits, treat as PMID
    if (/^\d{1,9}$/.test(candidate)) {
      return { raw: trimmed, clean: candidate, type: 'PMID' };
    }

    // 11. ISBN (including ISBN-10 and ISBN-13 with optional prefix)
    const isbnCandidate = candidate.replace(/^isbn(?:-1[03])?:?\s*/i, '');
    const isbnMatch = isbnCandidate.match(this.ISBN_REGEX);
    if (isbnMatch && isbnMatch[1]) {
      return {
        raw: trimmed,
        clean: isbnMatch[1].replace(/[-\s]/g, '').toUpperCase(),
        type: 'ISBN',
      };
    }

    // 12. Generic URL
    if (this.GENERIC_URL_REGEX.test(candidate)) {
      return { raw: trimmed, clean: candidate, type: 'URL' };
    }

    // 13. Default: Title or keyword search
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
