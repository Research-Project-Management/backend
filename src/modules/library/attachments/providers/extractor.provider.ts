import { Injectable, Logger } from '@nestjs/common';
import { extractText, getDocumentProxy } from 'unpdf';
import { isIP } from 'node:net';

export interface ExtractedPdfMetadata {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  title?: string;
  authors?: string[];
  year?: number;
  abstract?: string;
  keywords?: string[];
  journal?: string;
  creationDate?: string;
  rawText?: string;
}

export interface ExtractedPdfDocument {
  metadata: ExtractedPdfMetadata;
  pages: Array<{
    pageIndex: number;
    textContent: string;
    charOffset: number;
  }>;
}

@Injectable()
export class ExtractorService {
  private readonly logger = new Logger(ExtractorService.name);
  private static readonly TEXT_SCAN_LIMIT = 50_000;

  async extractDocumentFromBuffer(
    buffer: Buffer,
  ): Promise<ExtractedPdfDocument> {
    const pages: Array<{
      pageIndex: number;
      textContent: string;
      charOffset: number;
    }> = [];

    let combinedText = '';

    try {
      const document = await getDocumentProxy(buffer);
      const extracted = await extractText(document, { mergePages: false });
      const rawPages = Array.isArray(extracted?.text)
        ? extracted.text
        : typeof extracted === 'string'
          ? [extracted]
          : [];

      let currentOffset = 0;
      for (let i = 0; i < rawPages.length; i++) {
        const pageText = rawPages[i] || '';
        pages.push({
          pageIndex: i,
          textContent: pageText,
          charOffset: currentOffset,
        });
        currentOffset += pageText.length + 1;
        combinedText += (combinedText ? '\n' : '') + pageText;
      }
    } catch (err: any) {
      this.logger.warn(
        `PDF unpdf parse failed (encrypted or corrupted): ${err.message}`,
      );
    }

    // Extract metadata from header stream and text
    const headerMeta = this.extractMetadataFromBuffer(buffer);
    const textMeta = combinedText
      ? this.extractMetadataFromText(combinedText)
      : {};

    const metadata: ExtractedPdfMetadata = {
      doi: textMeta.doi || headerMeta.doi,
      arxivId: textMeta.arxivId || headerMeta.arxivId,
      pmid: textMeta.pmid || headerMeta.pmid,
      title: headerMeta.title || textMeta.title,
      authors:
        headerMeta.authors && headerMeta.authors.length > 0
          ? headerMeta.authors
          : textMeta.authors,
      year: headerMeta.year || textMeta.year,
      abstract: textMeta.abstract || headerMeta.abstract,
      keywords:
        textMeta.keywords && textMeta.keywords.length > 0
          ? textMeta.keywords
          : headerMeta.keywords,
      rawText: combinedText.slice(0, ExtractorService.TEXT_SCAN_LIMIT),
    };

    return {
      metadata,
      pages,
    };
  }

  async extractMetadataFromUrl(fileUrl: string): Promise<ExtractedPdfMetadata> {
    this.validateUrlSecurity(fileUrl);

    try {
      const response = await fetch(fileUrl, {
        headers: { 'User-Agent': 'Flux-Extractor/1.0' },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch PDF from URL: ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const doc = await this.extractDocumentFromBuffer(buffer);
      return doc.metadata;
    } catch (err: any) {
      this.logger.warn(`Remote PDF extraction failed: ${err.message}`);
      return {};
    }
  }

  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata {
    const rawHead = buffer.subarray(0, 32768).toString('latin1');
    const result: ExtractedPdfMetadata = {};

    const doiMatch = rawHead.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
    if (doiMatch) {
      result.doi = doiMatch[0].replace(/[.,;)\]]+$/, '');
    }

    const arxivMatch = rawHead.match(/arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (arxivMatch) {
      result.arxivId = arxivMatch[1];
    }

    const titleMatch = rawHead.match(/\/Title\s*\(([^)]+)\)/);
    if (titleMatch && titleMatch[1]) {
      result.title = titleMatch[1].trim();
    }

    const authorMatch = rawHead.match(/\/Author\s*\(([^)]+)\)/);
    if (authorMatch && authorMatch[1]) {
      result.authors = [authorMatch[1].trim()];
    }

    const dateMatch = rawHead.match(/\/CreationDate\s*\(D:(\d{4})/);
    if (dateMatch && dateMatch[1]) {
      result.year = parseInt(dateMatch[1], 10);
    }

    return result;
  }

  extractFromText(text: string): string | null {
    if (!text) return null;

    const scan = text.slice(0, ExtractorService.TEXT_SCAN_LIMIT);
    const joined = scan.replace(/(10\.\d{4,9}\/)\s+/g, '$1');
    const doiMatches = joined.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g) ?? [];

    for (const match of doiMatches) {
      const doi = match.replace(/[.,;)\]]+$/, '');
      if (/n{4,}/i.test(doi)) continue;
      return doi;
    }

    const arxivMatch = scan.match(/arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    return arxivMatch?.[1] ? `10.48550/arXiv.${arxivMatch[1]}` : null;
  }

  extractMetadataFromText(text: string): ExtractedPdfMetadata {
    const scan = text.slice(0, ExtractorService.TEXT_SCAN_LIMIT);
    const metadata: ExtractedPdfMetadata = {};
    const doi = this.extractFromText(
      scan.replace(/(10\.\d{4,9}\/)\s*\n\s*/g, '$1'),
    );
    if (doi) metadata.doi = doi;

    const arxivMatch = scan.match(/arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    if (arxivMatch?.[1]) metadata.arxivId = arxivMatch[1];

    const abstractMatch = scan.match(
      /Abstract[—:\-\s]+([\s\S]*?)(?:\n\s*(?:Index Terms|Keywords|1\.|I\. INTRODUCTION|INTRODUCTION)\b)/i,
    );
    if (abstractMatch?.[1])
      metadata.abstract = abstractMatch[1].replace(/\s+/g, ' ').trim();

    const keywordsMatch = scan.match(
      /(?:Index Terms|Keywords)[—:\-\s]+([^\n.]+)/i,
    );
    if (keywordsMatch?.[1]) {
      metadata.keywords = keywordsMatch[1]
        .split(/[,;]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean);
    }

    return metadata;
  }

  async extractFromBuffer(buffer: Buffer): Promise<string | null> {
    try {
      const doc = await this.extractDocumentFromBuffer(buffer);
      if (doc.metadata.doi) return doc.metadata.doi;
    } catch (err: any) {
      this.logger.warn(`extractFromBuffer failed: ${err.message}`);
    }

    return this.extractFromText(
      buffer.subarray(0, ExtractorService.TEXT_SCAN_LIMIT).toString('latin1'),
    );
  }

  private validateUrlSecurity(urlString: string): void {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      throw new Error('Invalid URL format');
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Forbidden protocol: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname;
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      throw new Error(`SSRF violation: Forbidden target domain ${hostname}`);
    }

    const cleanIp = hostname.replace(/^\[|\]$/g, '');
    if (isIP(cleanIp)) {
      if (
        cleanIp === '127.0.0.1' ||
        cleanIp === '::1' ||
        cleanIp.startsWith('127.') ||
        cleanIp.startsWith('10.') ||
        cleanIp.startsWith('192.168.') ||
        cleanIp.startsWith('169.254.') ||
        cleanIp.startsWith('fc00:') ||
        cleanIp.startsWith('fe80:') ||
        cleanIp === '0.0.0.0' ||
        cleanIp === '::' ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)
      ) {
        throw new Error(`SSRF violation: Forbidden IP ${cleanIp}`);
      }
    }
  }
}

export const PdfExtractorService = ExtractorService;
export type PdfExtractorService = ExtractorService;
export const PdfDoiExtractor = ExtractorService;
export type PdfDoiExtractor = ExtractorService;
