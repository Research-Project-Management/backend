import { ClassifiedQuery, QueryType } from '../types/metadata.types';

export class QueryClassifier {
  private static readonly DOI_REGEX =
    /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)$/i;

  private static readonly ARXIV_REGEX =
    /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:\.pdf)?$/i;

  private static readonly PMID_REGEX =
    /^(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/|pmid:\s*)?(\d{1,9})\/?$/i;

  private static readonly ISBN_REGEX =
    /^(?:isbn:?\s*|urn:isbn:)?(97[89][-\s]?(?:\d[-\s]?){9}\d|(?:\d[-\s]?){9}[\dX])$/i;

  private static readonly GENERIC_URL_REGEX = /^https?:\/\/[^\s$.?#].[^\s]*$/i;

  static classify(rawQuery: string): ClassifiedQuery {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return { raw: '', clean: '', type: 'TITLE' };
    }

    const trimmed = rawQuery.trim();

    const doiMatch = trimmed.match(this.DOI_REGEX);
    if (doiMatch && doiMatch[1]) {
      return { raw: trimmed, clean: doiMatch[1], type: 'DOI' };
    }

    const arxivMatch = trimmed.match(this.ARXIV_REGEX);
    if (arxivMatch && arxivMatch[1]) {
      return { raw: trimmed, clean: arxivMatch[1], type: 'ARXIV' };
    }

    const pmidMatch = trimmed.match(this.PMID_REGEX);
    if (pmidMatch && pmidMatch[1]) {
      return { raw: trimmed, clean: pmidMatch[1], type: 'PMID' };
    }

    const isbnMatch = trimmed.match(this.ISBN_REGEX);
    if (isbnMatch && isbnMatch[1]) {
      return {
        raw: trimmed,
        clean: isbnMatch[1].replace(/[-\s]/g, ''),
        type: 'ISBN',
      };
    }

    if (this.GENERIC_URL_REGEX.test(trimmed)) {
      return { raw: trimmed, clean: trimmed, type: 'URL' };
    }

    return { raw: trimmed, clean: trimmed, type: 'TITLE' };
  }
}

export const QueryClassifierUtil = QueryClassifier;
export type { QueryType, ClassifiedQuery };
