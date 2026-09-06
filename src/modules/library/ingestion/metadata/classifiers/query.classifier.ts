import { ClassifiedQuery, QueryType } from '../types/metadata.types';

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

  private static cleanDoiString(doi: string): string {
    let clean = doi.replace(/[.,;]+$/, '');
    if (clean.endsWith(')') && !clean.includes('(')) {
      clean = clean.slice(0, -1);
    }
    if (clean.endsWith(']') && !clean.includes('[')) {
      clean = clean.slice(0, -1);
    }
    return clean;
  }

  static classify(rawQuery: string): ClassifiedQuery {
    if (!rawQuery || typeof rawQuery !== 'string') {
      return { raw: '', clean: '', type: 'TITLE' };
    }

    const trimmed = rawQuery.trim();

    // 1. arXiv (URLs and IDs)
    const arxivMatch = trimmed.match(this.ARXIV_REGEX);
    if (arxivMatch && arxivMatch[1]) {
      return { raw: trimmed, clean: arxivMatch[1], type: 'ARXIV' };
    }

    // 2. PubMed Central (PMC URLs or bare PMCID)
    const pmcMatch = trimmed.match(this.PMC_REGEX);
    if (pmcMatch && pmcMatch[1]) {
      return { raw: trimmed, clean: pmcMatch[1].toUpperCase(), type: 'PMID' };
    }

    // 3. Nature Articles (nature.com/articles/<slug> -> 10.1038/<slug>)
    const natureMatch = trimmed.match(this.NATURE_REGEX);
    if (natureMatch && natureMatch[1]) {
      return {
        raw: trimmed,
        clean: `10.1038/${natureMatch[1]}`,
        type: 'DOI',
      };
    }

    // 4. Zenodo Records (zenodo.org/records/<id> -> 10.5281/zenodo.<id>)
    const zenodoMatch = trimmed.match(this.ZENODO_REGEX);
    if (zenodoMatch && zenodoMatch[1]) {
      return {
        raw: trimmed,
        clean: `10.5281/zenodo.${zenodoMatch[1]}`,
        type: 'DOI',
      };
    }

    // 5. BioRxiv / MedRxiv preprints
    const biorxivMatch = trimmed.match(this.BIORXIV_MEDRXIV_REGEX);
    if (biorxivMatch && biorxivMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(biorxivMatch[1].replace(/v\d+$/, '')),
        type: 'DOI',
      };
    }

    // 6. PLOS Articles (journals.plos.org/.../article?id=...)
    const plosMatch = trimmed.match(this.PLOS_REGEX);
    if (plosMatch && plosMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(decodeURIComponent(plosMatch[1])),
        type: 'DOI',
      };
    }

    // 7. Embedded DOI in publisher URLs (ACM, Wiley, Science, PNAS, Springer, OUP, etc.)
    const embeddedDoiMatch = trimmed.match(this.EMBEDDED_DOI_REGEX);
    if (embeddedDoiMatch && embeddedDoiMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(embeddedDoiMatch[1]),
        type: 'DOI',
      };
    }

    // 8. Direct or doi.org DOIs
    const doiMatch = trimmed.match(this.DOI_REGEX);
    if (doiMatch && doiMatch[1]) {
      return {
        raw: trimmed,
        clean: this.cleanDoiString(doiMatch[1]),
        type: 'DOI',
      };
    }

    // 9. PubMed (pubmed.ncbi.nlm.nih.gov/... or pmid:...)
    const pmidMatch = trimmed.match(this.PMID_REGEX);
    if (pmidMatch && pmidMatch[1]) {
      return { raw: trimmed, clean: pmidMatch[1], type: 'PMID' };
    }

    // 10. Bare numeric ID: if 1-9 digits, treat as PMID
    if (/^\d{1,9}$/.test(trimmed)) {
      return { raw: trimmed, clean: trimmed, type: 'PMID' };
    }

    // 11. ISBN
    const isbnMatch = trimmed.match(this.ISBN_REGEX);
    if (isbnMatch && isbnMatch[1]) {
      return {
        raw: trimmed,
        clean: isbnMatch[1].replace(/[-\s]/g, ''),
        type: 'ISBN',
      };
    }

    // 12. Generic URL
    if (this.GENERIC_URL_REGEX.test(trimmed)) {
      return { raw: trimmed, clean: trimmed, type: 'URL' };
    }

    // 13. Default: Title or keyword search
    return { raw: trimmed, clean: trimmed, type: 'TITLE' };
  }
}

export const QueryClassifierUtil = QueryClassifier;
export type { QueryType, ClassifiedQuery };
