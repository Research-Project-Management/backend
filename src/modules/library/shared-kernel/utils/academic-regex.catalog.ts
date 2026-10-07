import { Injectable } from '@nestjs/common';
import {
  cleanAuthorName,
  splitAuthorString,
  cleanAbstractText,
  normalizeAcademicTitleCase,
} from './bibliographic.utils';

export interface ExtractedRegexFields {
  doi?: string;
  arxivId?: string;
  primaryCategory?: string;
  pmid?: string;
  isbn?: string;
  issn?: string;
  title?: string;
  authors?: string[];
  year?: number;
  publicationDate?: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  abstract?: string;
  keywords?: string[];
  matchedSignatures: string[];
}

/**
 * Enterprise Academic Regex Catalog for deterministic metadata identification.
 * Complies with ISO 26324:2012 (DOI), arXiv Identifier Scheme, and major
 * publisher citation banners (IEEE, ACM, Elsevier, Springer Nature, Wiley).
 *
 * All regular expressions are bounded to prevent ReDoS (Catastrophic Backtracking).
 */
@Injectable()
export class AcademicRegexCatalog {
  // ── 1. Persistent Identifiers ─────────────────────────────────────────────

  /** Canonical DOI pattern according to ISO 26324 & Crossref recommendations */
  public static readonly DOI_PATTERN =
    /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/g;

  /** Comprehensive arXiv pattern supporting New-Style (2007+) and Old-Style (Pre-2007) */
  public static readonly ARXIV_PATTERN =
    /\b(?:arXiv:\s*)?(?:(\d{4}\.\d{4,5}(?:v\d+)?)|([a-z\-]+(?:\.[a-zA-Z]{2})?\/\d{7}(?:v\d+)?))(?:\s*\[([a-zA-Z\-]+(?:\.[a-zA-Z\-]+)?)\])?(?=[\s,;.)\]]|$)/gi;

  /** PubMed Identifier (PMID) */
  public static readonly PMID_PATTERN =
    /\b(?:PMID:?\s*|PubMed\s*(?:ID)?:?\s*)(\d{7,9})\b/i;

  /** International Standard Book Number (ISBN-10 and ISBN-13) */
  public static readonly ISBN_PATTERN =
    /(?:ISBN(?:-1[03])?:?\s*)([0-9Xx\s-]{10,20})\b/i;

  /** International Standard Serial Number (ISSN) */
  public static readonly ISSN_PATTERN = /\b\d{4}-\d{3}[\dX]\b/i;

  // ── 2. Publisher Citation Banners & Signatures ────────────────────────────

  /** IEEE Transactions / Conference stamp */
  public static readonly IEEE_VENUE_PATTERN =
    /(?:IEEE\s+Transactions\s+on\s+([^\n\r,]+)|(?:Proceedings\s+of\s+)?IEEE\s+([^\n\r,]+)),?\s*(?:vol\.?\s*(\d+))?,?\s*(?:no\.?\s*(\d+))?,?\s*pp\.?\s*(\d+[-–]\d+)?,?\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*)?(\d{4})/i;

  /** ACM Reference Format block */
  public static readonly ACM_REFERENCE_PATTERN =
    /ACM\s+Reference\s+Format:\s*([\s\S]*?)\.\s*(\d{4})\.\s*([\s\S]*?)\.\s*(?:In\s+([^\n\r]+?)(?:,\s*Article\s+(\d+))?,\s*(\d+)\s*pages|\b)/i;

  /** Elsevier Article History stamp */
  public static readonly ELSEVIER_HISTORY_PATTERN =
    /(?:Received|Accepted|Available online)\s+[^\n\r\d]*\d{1,2}\s+[A-Za-z]+\s+(20\d{2}|19\d{2})/i;

  /** Springer / Nature citation header strip */
  public static readonly NATURE_HEADER_PATTERN =
    /\bNature\s+(?:Communications\s+)?\((\d{4})\)\s*(\d+):(\d+[-–]\d+)/i;

  // ── 3. Structural Sections ────────────────────────────────────────────────

  /** Abstract block bounded lookahead to prevent ReDoS */
  public static readonly ABSTRACT_BOUNDARY_PATTERN =
    /(?:^|\n)\s*(?:Abstract|ABSTRACT|Summary)[—:\-\s.]*\s*([\s\S]{30,3500}?)(?=(?:\n\s*(?:Index\s+Terms|Key\s*words|Keywords|1\.?\s+Introduction|I\.?\s+INTRODUCTION|Background))|$)/i;

  /** Keywords / Index Terms */
  public static readonly KEYWORDS_PATTERN =
    /(?:Index\s+Terms|Keywords|Key\s*words)[—:\-\s]+([^\n\r]+)/i;

  /**
   * Sanitizes candidate DOI by removing trailing punctuation and decoding URL encodings.
   */
  public static cleanDoi(rawDoi?: string | null): string | undefined {
    if (!rawDoi || typeof rawDoi !== 'string') return undefined;
    let clean = rawDoi.trim().replace(/[.,;:)\]\s]+$/, '');
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // keep raw if URI malformed
    }
    // Strict ISO 26324 sanity check
    if (/^10\.\d{4,9}\/\S+$/i.test(clean) && !/n{4,}/i.test(clean)) {
      return clean;
    }
    return undefined;
  }

  /**
   * Executes multi-layer deterministic regex matching on the input document text.
   *
   * @param text The linearized text (typically first 30,000 chars of pages 1-2)
   */
  public static scan(text: string): ExtractedRegexFields {
    const result: ExtractedRegexFields = {
      matchedSignatures: [],
    };
    if (!text || text.trim().length === 0) return result;

    const boundedText = text.slice(0, 35000);

    // ── 1. Match Persistent Identifiers ─────────────────────────────────────
    // Clean up line breaks within DOIs (e.g. "10.1109/\nCVPR.2023.123")
    const joinedDoiText = boundedText
      .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
      .replace(/(10\.\d{4,9}\/)\s+/g, '$1');

    const doiMatches = [...joinedDoiText.matchAll(this.DOI_PATTERN)];
    for (const match of doiMatches) {
      const candidateDoi = this.cleanDoi(match[1]);
      if (candidateDoi) {
        result.doi = candidateDoi;
        result.matchedSignatures.push('DOI_ISO26324');
        break;
      }
    }

    // Match arXiv ID
    const arxivMatches = [...boundedText.matchAll(this.ARXIV_PATTERN)];
    if (arxivMatches.length > 0) {
      const m = arxivMatches[0];
      const arxivId = m[1] || m[2];
      if (arxivId) {
        result.arxivId = arxivId;
        if (m[3]) {
          result.primaryCategory = m[3];
        }
        result.matchedSignatures.push('ARXIV_SCHEME');
        if (!result.doi) {
          result.doi = `10.48550/arXiv.${arxivId}`;
        }
      }
    }

    // Match PMID
    const pmidMatch = boundedText.match(this.PMID_PATTERN);
    if (pmidMatch && pmidMatch[1]) {
      result.pmid = pmidMatch[1];
      result.matchedSignatures.push('PUBMED_PMID');
    }

    // Match ISBN
    const isbnMatch = boundedText.match(this.ISBN_PATTERN);
    if (isbnMatch && isbnMatch[1]) {
      const cleanIsbn = isbnMatch[1].replace(/[-\s]/g, '');
      if (cleanIsbn.length === 10 || cleanIsbn.length === 13) {
        result.isbn = cleanIsbn;
        result.matchedSignatures.push('ISBN');
      }
    }

    // Match ISSN
    const issnMatch = boundedText.match(this.ISSN_PATTERN);
    if (issnMatch && issnMatch[0]) {
      result.issn = issnMatch[0];
      result.matchedSignatures.push('ISSN');
    }

    // ── 2. Match Publisher Signatures ───────────────────────────────────────
    // IEEE
    const ieeeMatch = boundedText.match(this.IEEE_VENUE_PATTERN);
    if (ieeeMatch) {
      result.journal = (ieeeMatch[1] || ieeeMatch[2] || '').trim();
      if (ieeeMatch[3]) result.volume = ieeeMatch[3];
      if (ieeeMatch[4]) result.issue = ieeeMatch[4];
      if (ieeeMatch[5]) result.pages = ieeeMatch[5];
      if (ieeeMatch[6]) result.year = parseInt(ieeeMatch[6], 10);
      result.publisher = 'IEEE';
      result.matchedSignatures.push('IEEE_STAMP');
    }

    // ACM Reference Format
    const acmMatch = boundedText.match(this.ACM_REFERENCE_PATTERN);
    if (acmMatch) {
      const rawAuthors = acmMatch[1]?.trim();
      const rawYear = acmMatch[2]?.trim();
      const rawTitle = acmMatch[3]?.trim();
      const rawVenue = acmMatch[4]?.trim();

      if (rawAuthors && !result.authors) {
        result.authors = splitAuthorString(rawAuthors)
          .map((a) => cleanAuthorName(a))
          .filter(Boolean);
      }
      if (rawYear && !result.year) {
        result.year = parseInt(rawYear, 10);
      }
      if (rawTitle && !result.title) {
        result.title = normalizeAcademicTitleCase(rawTitle);
      }
      if (rawVenue && !result.journal) {
        result.journal = rawVenue;
      }
      result.publisher = 'ACM';
      result.matchedSignatures.push('ACM_REFERENCE_FORMAT');
    }

    // Elsevier
    const elsevierMatch = boundedText.match(this.ELSEVIER_HISTORY_PATTERN);
    if (elsevierMatch && elsevierMatch[1] && !result.year) {
      result.year = parseInt(elsevierMatch[1], 10);
      result.publisher = result.publisher || 'Elsevier';
      result.matchedSignatures.push('ELSEVIER_HISTORY');
    }

    // Nature
    const natureMatch = boundedText.match(this.NATURE_HEADER_PATTERN);
    if (natureMatch) {
      if (natureMatch[1] && !result.year) {
        result.year = parseInt(natureMatch[1], 10);
      }
      if (natureMatch[2]) result.volume = natureMatch[2];
      if (natureMatch[3]) result.pages = natureMatch[3];
      result.publisher = 'Nature Publishing Group';
      result.matchedSignatures.push('NATURE_HEADER');
    }

    // ── 3. Match Abstract & Keywords ────────────────────────────────────────
    const abstractMatch = boundedText.match(this.ABSTRACT_BOUNDARY_PATTERN);
    if (abstractMatch && abstractMatch[1]) {
      const cleanAbs = cleanAbstractText(abstractMatch[1].trim());
      if (cleanAbs && cleanAbs.length > 20) {
        result.abstract = cleanAbs;
      }
    }

    const keywordsMatch = boundedText.match(this.KEYWORDS_PATTERN);
    if (keywordsMatch && keywordsMatch[1]) {
      const rawTokens = keywordsMatch[1]
        .split(/[,;•]/)
        .map((k) => k.trim())
        .filter((k) => k.length > 1 && !/^\d+$/.test(k));
      if (rawTokens.length > 0) {
        result.keywords = rawTokens;
      }
    }

    return result;
  }
}
