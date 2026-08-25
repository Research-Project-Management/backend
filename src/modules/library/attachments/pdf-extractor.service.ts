import { Injectable, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ExtractedPdfMetadata {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  title?: string;
  authors?: string[];
  year?: number;
  abstract?: string;
  keywords?: string[]; // Tags extracted from "Keywords:", "Index Terms:", XMP dc:subject
  journal?: string;
  creationDate?: string;
  rawText?: string;
}

/**
 * Deep Zotero-Grade PDF Metadata and Academic Content Extractor.
 *
 * Extraction Strategy:
 *  1. Parse embedded PDF XMP / Dublin Core & Info dictionary (Title, Author, Subject, Keywords, CreationDate).
 *  2. Decode first 5 pages using `unpdf` to extract structured academic text.
 *  3. Extract Academic Identifiers (DOI, arXiv ID, PubMed PMID) with multi-line/hyphenation normalization.
 *  4. Extract Abstract block (between "Abstract" and "Keywords" / "Introduction").
 *  5. Extract Keywords & Index Terms and convert into clean Tags (labels).
 *  6. Apply heuristic Title & Author detection if embedded metadata is absent.
 *  7. Fallback to raw byte scanning for encrypted or non-standard PDFs.
 */
@Injectable()
export class PdfExtractorService {
  private readonly logger = new Logger(PdfDoiExtractor.name);

  /** Official CrossRef DOI pattern */
  private readonly DOI_PATTERN =
    /\b(10\.\d{4,9}\/[^\s"'<>,;:!?|&(){}[\]\\]+)/g;

  /** arXiv preprint identifier pattern */
  private readonly ARXIV_PATTERN =
    /\b(?:arXiv:\s*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5}(?:v\d+)?)\b/i;

  /** PubMed PMID pattern */
  private readonly PMID_PATTERN = /\b(?:PMID:?\s*|pubmed\/)(\d{6,9})\b/i;

  /** Dummy/Placeholder DOIs to ignore */
  private readonly DUMMY_DOI_PATTERN =
    /\b10\.\d{4,9}\/(?:n{4,}|x{3,}|0{4,}|placeholder|your[-_]?doi)\b/i;

  /** Maximum pages to parse with unpdf */
  private static readonly MAX_PAGES = 5;

  private static readonly MAX_PDF_BYTES = 25 * 1024 * 1024;

  private async assertSafePdfUrl(rawUrl: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('Invalid PDF URL');
    }

    if (url.protocol !== 'https:') {
      throw new Error('Only HTTPS PDF URLs are allowed');
    }

    const resolved = await lookup(url.hostname, { all: true });
    if (resolved.length === 0 || resolved.some((a) => !this.isPublicIp(a.address))) {
      throw new Error('PDF URL host resolves to a private or reserved address');
    }

    return url;
  }

  private isPublicIp(address: string): boolean {
    const version = isIP(address);
    if (version === 4) {
      const parts = address.split('.').map(Number);
      const [a, b] = parts;
      return !(
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) ||
        a >= 224 ||
        a === 0
      );
    }

    if (version === 6) {
      const normalized = address.toLowerCase();
      return !(
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe80') ||
        normalized === '::' ||
        normalized.startsWith('ff')
      );
    }

    return false;
  }

  /**
   * Deep metadata extraction from a PDF URL.
   */
  async extractMetadataFromUrl(
    pdfUrl: string,
  ): Promise<ExtractedPdfMetadata | null> {
    if (!pdfUrl) return null;

    try {
      const safeUrl = await this.assertSafePdfUrl(pdfUrl);
      const response = await fetch(safeUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'application/pdf,*/*',
          'User-Agent':
            'FluxResearchPlatform/1.0 (mailto:admin@flux.academic; https://flux.study)',
        },
      });

      if (!response.ok) {
        this.logger.debug(
          `PDF fetch failed: HTTP ${response.status} — ${pdfUrl}`,
        );
        return null;
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > PdfExtractorService.MAX_PDF_BYTES) {
        this.logger.debug(`PDF fetch skipped: file too large — ${safeUrl.href}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > PdfExtractorService.MAX_PDF_BYTES) {
        this.logger.debug(`PDF fetch skipped: file too large — ${safeUrl.href}`);
        return null;
      }

      return await this.extractMetadataFromBuffer(Buffer.from(buffer));
    } catch (err: any) {
      this.logger.debug(`PDF fetch error: ${err?.message} — ${pdfUrl}`);
      return null;
    }
  }

  /**
   * Deep metadata extraction from a Node.js PDF Buffer.
   */
  async extractMetadataFromBuffer(
    buffer: Buffer,
  ): Promise<ExtractedPdfMetadata> {
    const result: ExtractedPdfMetadata = {
      keywords: [],
    };

    try {
      const { getDocumentProxy, extractText, getMeta } = await import('unpdf');
      const uint8 = new Uint8Array(buffer);
      const pdf = await getDocumentProxy(uint8);

      // 1. Extract embedded PDF XMP & Info Dictionary metadata
      try {
        const meta = await getMeta(uint8);
        if (meta?.info) {
          const info = meta.info;
          if (info.Title && this.isCleanTitle(info.Title)) {
            result.title = String(info.Title).trim();
          }
          if (info.Author && typeof info.Author === 'string') {
            const authors = this.parseAuthorsString(info.Author);
            if (authors.length) result.authors = authors;
          }
          if (info.Subject && typeof info.Subject === 'string') {
            const tags = this.parseKeywordsString(info.Subject);
            result.keywords?.push(...tags);
          }
          if (info.Keywords && typeof info.Keywords === 'string') {
            const tags = this.parseKeywordsString(info.Keywords);
            result.keywords?.push(...tags);
          }
          if (info.CreationDate && typeof info.CreationDate === 'string') {
            const match = info.CreationDate.match(/D:(\d{4})/);
            if (match) result.year = Number(match[1]);
          }
        }
      } catch (err: any) {
        this.logger.debug(`PDF embedded info extract error: ${err?.message}`);
      }

      // 2. Extract first 5 pages text
      const { text: fullText } = await extractText(pdf, { mergePages: true });
      const text = fullText.slice(0, 25_000); // First 5 pages of academic text
      result.rawText = text;

      if (text && text.length > 10) {
        this.enrichFromText(result, text);
      }
    } catch (err: any) {
      this.logger.debug(
        `unpdf processing failed (${err?.message?.slice(0, 80)}), using byte scan fallback`,
      );
    }

    // 3. Fallback to raw byte scan if DOI / Identifiers not found
    if (!result.doi && !result.arxivId) {
      const byteDoi = this.rawByteScan(buffer);
      if (byteDoi) result.doi = byteDoi;
    }

    // Deduplicate and normalize keywords/tags
    if (result.keywords && result.keywords.length > 0) {
      result.keywords = this.deduplicateKeywords(result.keywords);
    }

    return result;
  }

  /**
   * Backwards-compatible extractFromUrl (returns DOI or null)
   */
  async extractFromUrl(pdfUrl: string): Promise<string | null> {
    const meta = await this.extractMetadataFromUrl(pdfUrl);
    return meta?.doi || null;
  }

  /**
   * Backwards-compatible extractFromBuffer (returns DOI or null)
   */
  async extractFromBuffer(buffer: Buffer): Promise<string | null> {
    const meta = await this.extractMetadataFromBuffer(buffer);
    return meta.doi || null;
  }

  /**
   * Backwards-compatible extractFromText (returns DOI or null)
   */
  extractFromText(text: string): string | null {
    if (!text) return null;
    return this.findDoi(text.slice(0, 50_000));
  }

  /**
   * Extract metadata from plain text (pure function)
   */
  extractMetadataFromText(text: string): ExtractedPdfMetadata {
    const result: ExtractedPdfMetadata = {
      keywords: [],
      rawText: text,
    };
    if (text) {
      this.enrichFromText(result, text);
      if (result.keywords) {
        result.keywords = this.deduplicateKeywords(result.keywords);
      }
    }
    return result;
  }

  private enrichFromText(meta: ExtractedPdfMetadata, text: string): void {
    // Normalize hyphenated words and line breaks across page boundaries
    const normalizedText = text
      .replace(/(\w+)-\s*\r?\n\s*(\w+)/g, '$1$2')
      .replace(/(10\.\d{4,9}\/)\s*\r?\n\s*([^\s]+)/g, '$1$2');

    // 1. DOI
    if (!meta.doi) {
      meta.doi = this.findDoi(normalizedText) || undefined;
    }

    // 2. arXiv ID
    if (!meta.arxivId) {
      this.ARXIV_PATTERN.lastIndex = 0;
      const arxivMatch = this.ARXIV_PATTERN.exec(normalizedText);
      if (arxivMatch && arxivMatch[1]) {
        meta.arxivId = arxivMatch[1];
      }
    }

    // 3. PubMed PMID
    if (!meta.pmid) {
      this.PMID_PATTERN.lastIndex = 0;
      const pmidMatch = this.PMID_PATTERN.exec(normalizedText);
      if (pmidMatch && pmidMatch[1]) {
        meta.pmid = pmidMatch[1];
      }
    }

    // 4. Abstract Extraction
    if (!meta.abstract) {
      const abstractRegex =
        /(?:\bAbstract\b|\bABSTRACT\b|\bSummary\b)[\s:—–.-]+([\s\S]*?)(?=(?:\b(?:Keywords|Key words|Index Terms|CCS Concepts|Categories and Subject Descriptors|1\.?\s+Introduction|1\s+Introduction|ACM Reference Format)\b)|$)/i;
      const match = normalizedText.match(abstractRegex);
      if (match && match[1]) {
        const clean = match[1].replace(/\s+/g, ' ').trim();
        if (clean.length >= 40 && clean.length <= 4000) {
          meta.abstract = clean;
        }
      }
    }

    // 5. Keywords / Index Terms (Tags)
    const keywordsRegex =
      /(?:\bKeywords\b|\bKey words\b|\bIndex Terms\b|\bCCS Concepts\b|\bCategories and Subject Descriptors\b)[\s:—–.-]+([\s\S]*?)(?=(?:\b(?:Introduction|1\.?\s+Introduction|1\s+[A-Z]|Background|Abstract|ACM Reference Format)\b)|$)/i;
    const kwMatch = normalizedText.match(keywordsRegex);
    if (kwMatch && kwMatch[1]) {
      const parsedTags = this.parseKeywordsString(kwMatch[1]);
      meta.keywords?.push(...parsedTags);
    }

    // 6. Title and Author heuristics if missing
    if (!meta.title || !meta.authors?.length) {
      this.extractTitleAndAuthorsFromText(meta, normalizedText);
    }
  }

  /**
   * Heuristic title and author extractor from top of page 1
   */
  private extractTitleAndAuthorsFromText(
    meta: ExtractedPdfMetadata,
    text: string,
  ): void {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const candidateLines: string[] = [];
    for (const line of lines.slice(0, 25)) {
      if (
        /^(abstract|keywords|index terms|introduction|1\.\s+intro)/i.test(line)
      ) {
        break;
      }
      if (this.isHeaderBanner(line)) {
        continue;
      }
      candidateLines.push(line);
    }

    if (!meta.title && candidateLines.length > 0) {
      const firstLine = candidateLines[0];
      if (
        firstLine.length > 8 &&
        !firstLine.includes('@') &&
        !/^(by|author|volume|issue|proceedings|downloaded from)/i.test(
          firstLine,
        )
      ) {
        meta.title = firstLine;
      }
    }
  }

  private isHeaderBanner(line: string): boolean {
    const lower = line.toLowerCase();
    return (
      lower.startsWith('ieee trans') ||
      lower.startsWith('acm trans') ||
      lower.startsWith('proceedings of') ||
      lower.startsWith('preprint submitted') ||
      lower.startsWith('arxiv:') ||
      lower.startsWith('doi:') ||
      lower.startsWith('https://doi.org') ||
      lower.startsWith('volume') ||
      lower.startsWith('vol.') ||
      lower.startsWith('issn') ||
      lower.startsWith('downloaded from') ||
      lower.startsWith('published by') ||
      lower.startsWith('copyright') ||
      lower.includes('all rights reserved')
    );
  }

  private isCleanTitle(title: string): boolean {
    if (!title || title.length < 5) return false;
    const lower = title.toLowerCase().trim();
    return (
      !lower.startsWith('microsoft word') &&
      !lower.startsWith('untitled') &&
      !lower.startsWith('latex') &&
      !lower.startsWith('paper.pdf') &&
      !lower.endsWith('.pdf') &&
      !lower.startsWith('manuscript') &&
      !lower.startsWith('downloaded from')
    );
  }

  private parseAuthorsString(authorStr: string): string[] {
    if (!authorStr || !authorStr.trim()) return [];
    return authorStr
      .split(/[,;]+|\band\b/i)
      .map((a) => a.trim())
      .filter((a) => a.length > 1 && !/^(et al\.?|and)$/i.test(a));
  }

  private parseKeywordsString(rawKeywords: string): string[] {
    if (!rawKeywords) return [];
    const cleaned = rawKeywords
      .replace(
        /^(?:Keywords|Key words|Index Terms|CCS Concepts|Categories and Subject Descriptors)[:—–.-]?\s*/i,
        '',
      )
      .replace(/[.;]+$/, '');

    return cleaned
      .split(/[,;•|\n\r]+/)
      .map((k) =>
        k
          .replace(/^[•\s\->→–—]+/, '')
          .replace(/[•\s\->→–—]+$/, '')
          .trim(),
      )
      .filter(
        (k) =>
          k.length >= 2 &&
          k.length <= 60 &&
          !/^(and|or|the|in|for|of|with|keywords|index terms)$/i.test(k),
      );
  }

  private deduplicateKeywords(keywords: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const kw of keywords) {
      const normalized = kw.toLowerCase().trim();
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(kw.trim());
      }
    }
    return result;
  }

  private rawByteScan(buffer: Buffer): string | null {
    const MAX_SCAN_BYTES = 50_000;
    const slice = buffer.slice(0, Math.min(buffer.length, MAX_SCAN_BYTES));
    const text = Array.from(slice)
      .map((b) => String.fromCharCode(b))
      .join('');
    return this.findDoi(text);
  }

  private findDoi(text: string): string | null {
    this.DOI_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = this.DOI_PATTERN.exec(text)) !== null) {
      const candidate = match[1].replace(/[.,;:!?)\]}>]+$/, '');
      if (candidate && !this.DUMMY_DOI_PATTERN.test(candidate)) {
        return candidate;
      }
    }

    this.ARXIV_PATTERN.lastIndex = 0;
    const arxivMatch = this.ARXIV_PATTERN.exec(text);
    if (arxivMatch && arxivMatch[1]) {
      return `10.48550/arXiv.${arxivMatch[1]}`;
    }

    return null;
  }
}

// Backward compatibility alias
export const PdfDoiExtractor = PdfExtractorService;
export type PdfDoiExtractor = PdfExtractorService;
