import { cleanAuthorName, splitAuthorString } from './author.domain';
import { cleanAbstractText } from './academic-text.domain';
import { normalizeAcademicTitleCase } from './academic-title.domain';
import { normalizeAcademicTags } from './tag.domain';
import {
  isValidIsbnChecksum,
  isValidIssnChecksum,
} from './identifier.domain';

export interface ExtractedRegexFields {
  doi?: string;
  candidateDois?: Array<{ doi: string; score: number }>;
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
export class AcademicRegexCatalog {
  // 1. Persistent Identifiers

  /** Canonical DOI pattern according to ISO 26324 & Crossref recommendations */
  public static readonly DOI_PATTERN =
    /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/g;

  /** Comprehensive arXiv pattern supporting New-Style (2007+) and Old-Style (Pre-2007) */
  public static readonly ARXIV_PATTERN =
    /\b(?:arXiv:\s*)?(?:(\d{4}\.\d{4,5}(?:v\d+)?)|([a-z-]+(?:\.[a-zA-Z]{2})?\/\d{7}(?:v\d+)?))(?:\s*\[([a-zA-Z-]+(?:\.[a-zA-Z-]+)?)\])?(?=[\s,;.)\]]|$)/gi;

  /** PubMed Identifier (PMID) */
  public static readonly PMID_PATTERN =
    /\b(?:PMID:?\s*|PubMed\s*(?:ID)?:?\s*)(\d{7,9})\b/i;

  /** International Standard Book Number (ISBN-10 and ISBN-13) */
  public static readonly ISBN_PATTERN =
    /(?:ISBN(?:-1[03])?:?[ \t]*)([0-9Xx -]{10,20})\b/i;

  /** International Standard Serial Number (ISSN) */
  public static readonly ISSN_PATTERN = /\b\d{4}-\d{3}[\dX]\b/i;

  // 2. Publisher Citation Banners & Signatures

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
  /** JMLR (Journal of Machine Learning Research) banner strip */
  public static readonly JMLR_HEADER_PATTERN =
    /(?:Journal\s+of\s+Machine\s+Learning\s+Research|JMLR)\s+(\d+)\s*\((20\d{2}|19\d{2})\)\s*(\d+[-–]\d+)/i;

  public static readonly NATURE_HEADER_PATTERN =
    /\bNature\s+(?:Communications\s+)?\((\d{4})\)\s*(\d+):(\d+[-–]\d+)/i;

  /** Major academic book & journal publisher imprints */
  public static readonly PUBLISHER_IMPRINT_PATTERN =
    /\b((?:MIT|Oxford\s+University|Cambridge\s+University|Princeton\s+University|Harvard\s+University|Stanford\s+University|Yale\s+University|University\s+of\s+Chicago|University\s+of\s+California|Columbia\s+University|Johns\s+Hopkins\s+University|Cornell\s+University)\s+Press|Springer(?:\s+Nature)?|Elsevier|Wiley(?:-Blackwell)?|Taylor\s*&\s*Francis|Routledge|SAGE\s+Publications|Macmillan|Academic\s+Press|Addison-Wesley|O'Reilly\s+Media|Morgan\s+Kaufmann|CRC\s+Press|World\s+Scientific|now\s+Publishers)\b/i;

  // 3. Structural Sections

  /** Abstract block bounded lookahead to prevent ReDoS */
  public static readonly ABSTRACT_BOUNDARY_PATTERN =
    /(?:^|\n)\s*(?:Abstract|ABSTRACT|Summary)[—:\-\s.]*\s*([\s\S]{30,3500}?)(?=(?:\n\s*(?:Index\s+Terms|Key\s*words|Keywords|1\.?\s+Introduction|I\.?\s+INTRODUCTION|Background))|$)/i;

  /** Keywords / Index Terms (supports both same-line with delimiters and next-line block headers) */
  public static readonly KEYWORDS_PATTERN =
    /(?:^|\n)\s*(?:Index\s+Terms|Keywords|Key\s*words)\s*(?:[—:\-–]|\r?\n)\s*([\s\S]*?)(?=(?:\r?\n\s*\r?\n)|(?:\r?\n\s*(?:(?:1\b|I\b|1\.?\s+|I\.?\s+)?(?:Introduction|INTRODUCTION|Background|Correspondence|Received|Accepted|Funding|Conflict|PACS|\d\s+[A-Z])))|(?:\.\s*(?:\r?\n|$))|$)/i;

  /**
   * Sanitizes candidate DOI by removing trailing punctuation and decoding URL encodings.
   */
  public static cleanDoi(rawDoi?: string | null): string | undefined {
    if (!rawDoi || typeof rawDoi !== 'string') return undefined;
    let clean = rawDoi.trim();
    let prev = '';
    while (clean !== prev) {
      prev = clean;
      clean = clean.replace(/[.,;:\s]+$/, '');
      if (clean.endsWith(')')) {
        const openParens = (clean.match(/\(/g) || []).length;
        const closeParens = (clean.match(/\)/g) || []).length;
        if (closeParens > openParens) {
          clean = clean.slice(0, -1).trim();
        }
      }
      if (clean.endsWith(']')) {
        const openBrackets = (clean.match(/\[/g) || []).length;
        const closeBrackets = (clean.match(/\]/g) || []).length;
        if (closeBrackets > openBrackets) {
          clean = clean.slice(0, -1).trim();
        }
      }
    }
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
   * Finds the true start offset of the References / Bibliography section while
   * ignoring Table of Contents entries (e.g. `\n  References ........ 42\n`).
   */
  private static findBibliographyPosition(
    text: string,
    introPos: number = -1,
  ): number {
    const headerPattern =
      /\n[ \t]*(?:(?:\d+\.?|[IVX]+\.)[ \t]+)?(?:references|bibliography|literature[ \t]+cited)[ \t]*:?[ \t]*([^\n\r]*)/gi;
    for (const m of text.matchAll(headerPattern)) {
      const idx = m.index ?? -1;
      if (idx === -1) continue;
      const trailingOnLine = (m[1] || '').trim();
      // Ignore TOC entries with leader dots, dashes, or page numbers on the same line
      if (trailingOnLine.length > 0) {
        continue;
      }
      // Ignore TOC entries appearing before the Introduction heading
      if (introPos !== -1 && idx < introPos) {
        continue;
      }
      return idx;
    }
    return -1;
  }

  /**
   * Scores a candidate DOI based on surrounding structural signals to disambiguate
   * between the paper's own publication DOI and cited reference DOIs appearing on page 1.
   */
  /**
   * Scores a candidate arXiv ID to determine whether it is the document's own
   * persistent preprint identifier or merely an inline citation to an external paper.
   */
  public static scoreArxivCandidate(
    arxivId: string,
    matchIndex: number,
    text: string,
  ): number {
    let score = 50;

    const prefix = text
      .slice(Math.max(0, matchIndex - 150), matchIndex)
      .toLowerCase();

    // Positive: Explicit arXiv header indicators (e.g. arXiv:2303.08774v2 [cs.CV] or 'arxiv.org')
    if (/(?:arxiv(?::|\.org\/abs\/|\.org\/pdf\/)|posted\s+on\s+arxiv)/i.test(prefix)) {
      score += 35;
    }

    // Positive: Appears in first 1500 chars (Page 1 top header/title strip)
    if (matchIndex < 1500) {
      score += 30;
    }

    // Negative: Reference numbers e.g. [1], (12), [24]
    if (/(?:\[\s*\d+\s*\]|\(\s*\d+\s*\)|ref(?:erence)?s?[:\s])/i.test(prefix)) {
      score -= 50;
    }

    // Negative: Inline citation wording ('et al.', 'proposed by', 'in [')
    if (/(?:et\s+al\.?|see\s+also|cited\s+(?:in|by)|according\s+to|proposed\s+by|in\s+\[)/i.test(prefix)) {
      score -= 45;
    }

    // Negative: Deep in text after Introduction
    const introPos = text.search(/(?:\n\s*(?:1\.?\s+)?introduction|\n\s*i\.?\s+introduction)/i);
    if (introPos !== -1 && matchIndex > introPos) {
      score -= 35;
    }

    // Negative: Near References / Bibliography
    const refPos = text.search(/(?:\n\s*references|\n\s*bibliography|\n\s*literature\s+cited)/i);
    if (refPos !== -1 && matchIndex > refPos) {
      score -= 60;
    }

    return score;
  }

  public static scoreDoiCandidate(
    doi: string,
    matchIndex: number,
    text: string,
  ): number {
    let score = 50; // base score

    const prefix = text
      .slice(Math.max(0, matchIndex - 150), matchIndex)
      .toLowerCase();
    const suffix = text
      .slice(matchIndex + doi.length, matchIndex + doi.length + 150)
      .toLowerCase();
    const lineContext = `${prefix}${doi.toLowerCase()}${suffix}`;

    // Positive: Explicit DOI prefix or link
    if (
      /(?:doi(?:\.org)?[:\s/]+|https?:\/\/(?:dx\.)?doi\.org\/|digital\s+object\s+identifier)/i.test(
        prefix,
      )
    ) {
      score += 40;
    }

    // Positive: Located in top header strip (< 1500 chars)
    if (matchIndex < 1500) {
      score += 30;
    }

    // Positive: Publisher imprint / copyright / citation banner
    // Guarded against inline citation markers (e.g. "et al." or "[1]") so cited references mentioning a venue don't receive the banner bonus
    if (
      /(?:ieee|acm|elsevier|springer|nature|wiley|plos|mdpi|frontiers|biorxiv|medrxiv|taylor\s*&\s*francis|oxford\s+university\s+press|cambridge|copyright|all\s+rights\s+reserved|©|\bvol\.?\s*\d+|\bissue\s*\d+|received:|accepted:|published:)/i.test(
        lineContext,
      ) &&
      !/\b(?:et\s+al\.?)\b|\[\s*\d+\s*\]/i.test(lineContext)
    ) {
      score += 35;
    }

    // Positive: "Cite this article as", "How to cite"
    if (/(?:cite\s+this|how\s+to\s+cite|to\s+cite|citation:)/i.test(prefix)) {
      score += 30;
    }

    // Negative: Reference number prefixes e.g. [1], (1), 1., 2.
    if (
      /(?:\[\s*\d+\s*\]|\(\s*\d+\s*\)|^\s*\d+\.\s+|ref(?:erence)?s?[:\s](?!\s*\.{2,}))/i.test(
        prefix,
      )
    ) {
      score -= 50;
    }

    // Negative: Citation phrasing "et al.", "see also", "cited in", "cites:"
    if (
      /(?:et\s+al\.?|see\s+also|cited\s+(?:in|by)|according\s+to|proposed\s+by|in\s+\[)/i.test(
        prefix,
      )
    ) {
      score -= 45;
    }

    // Negative: Comparative / derivative / figure credit citation phrases
    if (
      /(?:adapted\s+from|reproduced\s+from|reprinted\s+from|courtesy\s+of|compared\s+(?:to|with)|builds\s+(?:on|upon)|benchmark\s+from|dataset\s+from)\b/i.test(
        prefix,
      )
    ) {
      score -= 65;
    }

    // Negative: Deep in the text after an Introduction header (ignore TOC lines with leader dots)
    const introPos = text.search(
      /\n[ \t]*(?:1\.?[ \t]+|i\.?[ \t]+)?introduction[ \t]*:?[ \t]*(?:\r?\n|$)/i,
    );
    if (introPos !== -1 && matchIndex > introPos) {
      score -= 30;
    }

    // Negative: Near "References" or "Bibliography"
    const refPos = this.findBibliographyPosition(text, introPos);
    if (refPos !== -1 && matchIndex > refPos) {
      score -= 60;
    }

    return score;
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

    // 1. Match Persistent Identifiers
    // Clean up line breaks within DOIs (e.g. "10.1109/\nCVPR.2023.123")
    const joinedDoiText = boundedText
      .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
      .replace(/(10\.\d{4,9}\/)\s+/g, '$1');

    const doiMatches = [...joinedDoiText.matchAll(this.DOI_PATTERN)];
    if (doiMatches.length > 0) {
      const scoredCandidates: Array<{
        doi: string;
        score: number;
        index: number;
      }> = [];
      const seenDois = new Set<string>();

      for (const match of doiMatches) {
        const candidateDoi = this.cleanDoi(match[1]);
        if (candidateDoi && !seenDois.has(candidateDoi.toLowerCase())) {
          seenDois.add(candidateDoi.toLowerCase());
          const matchIndex = match.index ?? 0;
          const score = this.scoreDoiCandidate(
            candidateDoi,
            matchIndex,
            joinedDoiText,
          );
          scoredCandidates.push({
            doi: candidateDoi,
            score,
            index: matchIndex,
          });
        }
      }

      if (scoredCandidates.length > 0) {
        // Sort descending by score. If tied, favor earlier occurrence (e.g. header over body)
        scoredCandidates.sort((a, b) => b.score - a.score || a.index - b.index);
        const bestCandidate = scoredCandidates[0];
        if (bestCandidate.score >= 0) {
          result.doi = bestCandidate.doi;
          result.matchedSignatures.push('DOI_ISO26324');
        }
        result.candidateDois = scoredCandidates.map((c) => ({
          doi: c.doi,
          score: c.score,
        }));
      }
    }

    // Match arXiv ID with structural disambiguation (filter out cited reference arXiv IDs)
    const arxivMatches = [...boundedText.matchAll(this.ARXIV_PATTERN)];
    if (arxivMatches.length > 0) {
      const scoredArxiv: Array<{
        arxivId: string;
        category?: string;
        score: number;
        index: number;
      }> = [];
      const seenArxiv = new Set<string>();

      for (const m of arxivMatches) {
        const id = m[1] || m[2];
        if (id && !seenArxiv.has(id.toLowerCase())) {
          seenArxiv.add(id.toLowerCase());
          const matchIndex = m.index ?? 0;
          let score = this.scoreArxivCandidate(id, matchIndex, boundedText);
          // The arXiv watermark ("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023") is a rotated margin
          // stamp that PDF text layers emit AFTER the page body, so position-based signals
          // wrongly penalise it. Its bracketed subject class is unique to the paper's own
          // stamp (citations never carry one), hence a strong self-identification signal.
          if (m[3] && /^arxiv:/i.test(m[0])) {
            const refPos = boundedText.search(
              /(?:\n\s*references|\n\s*bibliography|\n\s*literature\s+cited)/i,
            );
            if (refPos === -1 || matchIndex < refPos) {
              score = Math.max(score, 90);
            }
          }
          scoredArxiv.push({
            arxivId: id,
            category: m[3],
            score,
            index: matchIndex,
          });
        }
      }

      if (scoredArxiv.length > 0) {
        scoredArxiv.sort((a, b) => b.score - a.score || a.index - b.index);
        const bestArxiv = scoredArxiv[0];
        // Require explicit arXiv stamp or top-of-page header signal (score >= 80)
        // so bare numbers or cited preprints in body/references are never promoted to the paper's own arXiv ID.
        if (bestArxiv.score >= 80) {
          result.arxivId = bestArxiv.arxivId;
          if (bestArxiv.category) {
            result.primaryCategory = bestArxiv.category;
          }
          result.matchedSignatures.push('ARXIV_SCHEME');
          if (!result.doi) {
            result.doi = `10.48550/arXiv.${bestArxiv.arxivId}`;
          }
        }
      }
    }

    // Match PMID
    const pmidMatch = boundedText.match(this.PMID_PATTERN);
    if (pmidMatch && pmidMatch[1]) {
      result.pmid = pmidMatch[1];
      result.matchedSignatures.push('PUBMED_PMID');
    }

    // Match ISBN (require valid ISBN-10 or ISBN-13 checksum)
    const isbnMatches = [
      ...boundedText.matchAll(new RegExp(this.ISBN_PATTERN.source, 'gi')),
    ];
    for (const isbnMatch of isbnMatches) {
      if (!isbnMatch[1]) continue;
      const cleanIsbn = isbnMatch[1].replace(/[-\s]/g, '').toUpperCase();
      if (
        (cleanIsbn.length === 10 || cleanIsbn.length === 13) &&
        isValidIsbnChecksum(cleanIsbn)
      ) {
        result.isbn = cleanIsbn;
        result.matchedSignatures.push('ISBN');
        break;
      }
    }

    // Match ISSN (require valid ISO 3297 mod-11 checksum and reject bare 4-digit year ranges like 2020-2024)
    const issnMatches = [
      ...boundedText.matchAll(new RegExp(this.ISSN_PATTERN.source, 'gi')),
    ];
    for (const issnMatch of issnMatches) {
      const candidateIssn = issnMatch[0].toUpperCase();
      if (!isValidIssnChecksum(candidateIssn)) continue;
      const matchIndex = issnMatch.index ?? 0;
      const preceding = boundedText.slice(
        Math.max(0, matchIndex - 20),
        matchIndex,
      );
      if (
        /^(?:19|20)\d{2}-(?:19|20)\d{2}$/.test(candidateIssn) &&
        !/\bISSN\b/i.test(preceding)
      ) {
        continue;
      }
      result.issn = candidateIssn;
      result.matchedSignatures.push('ISSN');
      break;
    }

    // 2. Match Publisher Signatures
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

    // JMLR (Journal of Machine Learning Research)
    const jmlrMatch = boundedText.match(this.JMLR_HEADER_PATTERN);
    if (jmlrMatch) {
      if (jmlrMatch[1]) result.volume = jmlrMatch[1];
      if (jmlrMatch[2] && !result.year) {
        result.year = parseInt(jmlrMatch[2], 10);
      }
      if (jmlrMatch[3]) result.pages = jmlrMatch[3];
      result.journal = 'Journal of Machine Learning Research';
      result.publisher = 'Microtome Publishing / JMLR.org';
      result.matchedSignatures.push('JMLR_BANNER');

      // If document was mistakenly given a synthetic arXiv DOI, drop it because it is a formal JMLR publication
      if (result.doi && result.doi.startsWith('10.48550/arXiv.')) {
        delete result.doi;
      }
      if (result.arxivId && !boundedText.slice(0, 500).includes('arXiv:')) {
        delete result.arxivId;
      }
    }

    if (!result.publisher) {
      const imprintMatch = boundedText.match(this.PUBLISHER_IMPRINT_PATTERN);
      if (imprintMatch && imprintMatch[1]) {
        result.publisher = imprintMatch[1].replace(/\s+/g, ' ').trim();
      }
    }

    // 3. Match Abstract & Keywords
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
        .split(/[,;•|\n]/)
        .map((k) => k.trim())
        .filter((k) => k.length > 1 && k.split(/\s+/).length <= 7);
      const normalized = normalizeAcademicTags(rawTokens);
      if (normalized.length > 0) {
        result.keywords = normalized;
      }
    }

    return result;
  }
}
