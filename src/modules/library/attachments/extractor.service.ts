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

@Injectable()
export class ExtractorService {
  private readonly logger = new Logger(ExtractorService.name);
  private static readonly TEXT_SCAN_LIMIT = 50_000;

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

      return this.extractMetadataFromBuffer(buffer);
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
      const document = await getDocumentProxy(buffer);
      const extracted = await extractText(document, { mergePages: true });
      const text = typeof extracted === 'string' ? extracted : extracted?.text;
      const doi = this.extractFromText(text ?? '');
      if (doi) return doi;
      if (text) return null;
    } catch (err: any) {
      this.logger.warn(
        `PDF text extraction failed, falling back to raw scan: ${err.message}`,
      );
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
      hostname.endsWith('.internal')
    ) {
      throw new Error(`SSRF violation: Forbidden target domain ${hostname}`);
    }

    const cleanIp = hostname.replace(/^\[|\]$/g, '');
    if (isIP(cleanIp)) {
      if (
        cleanIp.startsWith('127.') ||
        cleanIp.startsWith('10.') ||
        cleanIp.startsWith('192.168.') ||
        cleanIp.startsWith('169.254.')
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
