export type AcademicQueryType = 'DOI' | 'ARXIV' | 'PMID' | 'ISBN' | 'URL' | 'TITLE';

export interface ClassifiedQuery {
  raw: string;
  clean: string;
  type: AcademicQueryType;
}

export class QueryClassifierUtil {
  private static readonly DOI_REGEX =
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)$/i;

  private static readonly ARXIV_REGEX =
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[a-z]{2})?\/\d{7})(?:\.pdf)?$/i;

  private static readonly PMID_REGEX =
    /^(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/|pmid:\s*)?(\d{1,9})\/?$/i;

  private static readonly ISBN_REGEX =
    /^(?:isbn:?\s*|urn:isbn:)?(97[89][-\s]?(?:\d[-\s]?){9}\d|(?:\d[-\s]?){9}[\dX])$/i;

  private static readonly GENERIC_URL_REGEX = /^https?:\/\/[^\s$.?#].[^\s]*$/i;

  /**
   * Classifies an arbitrary search string into an AcademicQueryType and returns cleaned query token
   */
  static classify(rawQuery: string): ClassifiedQuery {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return { raw: '', clean: '', type: 'TITLE' };
    }

    const trimmed = rawQuery.trim();

    // 1. Test DOI
    const doiMatch = trimmed.match(this.DOI_REGEX);
    if (doiMatch && doiMatch[1]) {
      return {
        raw: trimmed,
        clean: doiMatch[1],
        type: 'DOI',
      };
    }

    // 2. Test arXiv
    const arxivMatch = trimmed.match(this.ARXIV_REGEX);
    if (arxivMatch && arxivMatch[1]) {
      return {
        raw: trimmed,
        clean: arxivMatch[1],
        type: 'ARXIV',
      };
    }

    // 3. Test PubMed PMID
    const pmidMatch = trimmed.match(this.PMID_REGEX);
    if (pmidMatch && pmidMatch[1]) {
      return {
        raw: trimmed,
        clean: pmidMatch[1],
        type: 'PMID',
      };
    }

    // 4. Test ISBN
    const isbnMatch = trimmed.match(this.ISBN_REGEX);
    if (isbnMatch && isbnMatch[1]) {
      return {
        raw: trimmed,
        clean: isbnMatch[1].replace(/[-\s]/g, ''),
        type: 'ISBN',
      };
    }

    // 5. Test Generic URL
    if (this.GENERIC_URL_REGEX.test(trimmed)) {
      return {
        raw: trimmed,
        clean: trimmed,
        type: 'URL',
      };
    }

    // 6. Default to Title / Keyword search
    return {
      raw: trimmed,
      clean: trimmed,
      type: 'TITLE',
    };
  }
}
