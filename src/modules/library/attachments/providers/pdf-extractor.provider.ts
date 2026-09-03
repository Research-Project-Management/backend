import { Injectable, Logger } from '@nestjs/common';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
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
export class PdfExtractorProvider {
  private readonly logger = new Logger(PdfExtractorProvider.name);
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
    const unpdfMeta: ExtractedPdfMetadata = {};

    try {
      const document = await getDocumentProxy(buffer);

      try {
        const docInfo = await getMeta(document);
        if (docInfo?.info) {
          const info = docInfo.info;
          if (typeof info.Title === 'string') {
            const cleanTitle = info.Title.trim();
            if (
              cleanTitle.length > 5 &&
              !cleanTitle.toLowerCase().endsWith('.pdf') &&
              !/^(untitled|document|microsoft word)/i.test(cleanTitle)
            ) {
              unpdfMeta.title = cleanTitle;
            }
          }
          if (typeof info.Author === 'string') {
            const cleanAuthor = info.Author.trim();
            if (
              cleanAuthor.length > 2 &&
              !/^(administrator|user|owner|unknown)$/i.test(cleanAuthor)
            ) {
              const list = cleanAuthor
                .split(/[,;\n]|\band\b/i)
                .map((a: string) => a.trim())
                .filter((a: string) => a.length > 1 && !/^\d+$/.test(a));
              if (list.length > 0) {
                unpdfMeta.authors = list;
              }
            }
          }
          if (typeof info.CreationDate === 'string') {
            const yearMatch = info.CreationDate.match(/D:(\d{4})/);
            if (yearMatch?.[1]) {
              unpdfMeta.year = parseInt(yearMatch[1], 10);
            }
          }
          if (typeof info.Keywords === 'string') {
            const kw = info.Keywords.split(/[,;]/)
              .map((k: string) => k.trim())
              .filter(Boolean);
            if (kw.length > 0) unpdfMeta.keywords = kw;
          }
        }
      } catch {
        // Optional metadata inspection
      }

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
      doi: textMeta.doi || unpdfMeta.doi || headerMeta.doi,
      arxivId: textMeta.arxivId || unpdfMeta.arxivId || headerMeta.arxivId,
      title:
        textMeta.title ||
        unpdfMeta.title ||
        (headerMeta.title &&
        !headerMeta.title.toLowerCase().endsWith('.pdf') &&
        !/^\d{4}\.\d{4,5}/.test(headerMeta.title) &&
        headerMeta.title.length > 5
          ? headerMeta.title
          : undefined),
      authors:
        textMeta.authors && textMeta.authors.length > 0
          ? textMeta.authors
          : unpdfMeta.authors && unpdfMeta.authors.length > 0
            ? unpdfMeta.authors
            : headerMeta.authors,
      year: textMeta.year || unpdfMeta.year || headerMeta.year,
      abstract: textMeta.abstract || headerMeta.abstract,
      keywords:
        textMeta.keywords && textMeta.keywords.length > 0
          ? textMeta.keywords
          : unpdfMeta.keywords && unpdfMeta.keywords.length > 0
            ? unpdfMeta.keywords
            : headerMeta.keywords,
      rawText: combinedText.slice(0, PdfExtractorProvider.TEXT_SCAN_LIMIT),
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

    const scan = text.slice(0, PdfExtractorProvider.TEXT_SCAN_LIMIT);
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
    const scan = text.slice(0, PdfExtractorProvider.TEXT_SCAN_LIMIT);
    const metadata: ExtractedPdfMetadata = {};
    const doi = this.extractFromText(
      scan.replace(/(10\.\d{4,9}\/)\s*\n\s*/g, '$1'),
    );
    if (doi) metadata.doi = doi;

    const arxivMatch = scan.match(
      /(?:arxiv[:\s._\/-]+)(\d{4}\.\d{4,5}(?:v\d+)?)/i,
    );
    if (arxivMatch?.[1]) {
      metadata.arxivId = arxivMatch[1];
    } else {
      const standalone = scan
        .slice(0, 1500)
        .match(/\b(1[0-9]{3}\.[0-9]{4,5}(?:v[0-9]+)?)\b/);
      if (standalone?.[1]) metadata.arxivId = standalone[1];
    }

    const abstractMatch = scan.match(
      /Abstract[—:\-\s]+([\s\S]*?)(?=(?:\n\s*(?:Index Terms|Keywords|1\.|I\. INTRODUCTION|INTRODUCTION)\b)|$)/i,
    );
    if (abstractMatch?.[1]) {
      const cleanAbstract = abstractMatch[1].replace(/\s+/g, ' ').trim();
      if (cleanAbstract.length > 10) {
        metadata.abstract = cleanAbstract.slice(0, 2500);
      }
    }

    const keywordsMatch = scan.match(
      /(?:Index Terms|Keywords)[—:\-\s]+([^\n.]+)/i,
    );
    if (keywordsMatch?.[1]) {
      metadata.keywords = keywordsMatch[1]
        .split(/[,;]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean);
    }

    // Extract Title and Authors from first page header lines
    const lines = scan
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    let abstractIndex = -1;
    for (let i = 0; i < Math.min(lines.length, 60); i++) {
      if (/^abstract\b/i.test(lines[i])) {
        abstractIndex = i;
        break;
      }
    }

    const headerLines =
      abstractIndex !== -1 ? lines.slice(0, abstractIndex) : lines.slice(0, 25);
    const cleanLines = headerLines.filter((l) => {
      if (
        /^(arxiv[:\s._\/-]*\d|https?:\/\/|\d+$|submitted to|accepted (as|at)|proceedings of|ieee|acm|springer|elsevier)/i.test(
          l,
        )
      )
        return false;
      if (/copyright|all rights reserved|doi:\s*10\./i.test(l)) return false;
      return true;
    });

    if (cleanLines.length > 0) {
      const titleLines: string[] = [];
      let authorStartIndex = -1;

      for (let i = 0; i < cleanLines.length; i++) {
        const l = cleanLines[i];
        if (
          /@|univ|institute|department|college|laboratory|school|hospital|center/i.test(
            l,
          )
        ) {
          if (authorStartIndex === -1) authorStartIndex = i;
          break;
        }
        const hasCommaOrAnd = /(?:,|\band\b)/i.test(l);
        const words = l.split(/\s+/);
        const looksLikeMultipleNames =
          words.length >= 4 &&
          words.every((w) => /^[A-ZÀ-Ỹ]/.test(w) || /[*†‡§\d]/.test(w));

        if (
          titleLines.length > 0 &&
          (hasCommaOrAnd || looksLikeMultipleNames)
        ) {
          authorStartIndex = i;
          break;
        }

        titleLines.push(l);
        if (l.length >= 25 || titleLines.length >= 2) {
          authorStartIndex = i + 1;
          break;
        }
      }

      const candidateTitle = titleLines.join(' ').replace(/\s+/g, ' ').trim();
      if (candidateTitle.length > 5 && candidateTitle.length < 250) {
        metadata.title = candidateTitle;
      }

      const parsedAuthors: string[] = [];
      if (authorStartIndex !== -1 && authorStartIndex < cleanLines.length) {
        for (let i = authorStartIndex; i < cleanLines.length; i++) {
          const l = cleanLines[i];
          if (
            /@|univ|institute|department|college|laboratory|school|hospital|center|research|microsoft|google/i.test(
              l,
            )
          ) {
            break;
          }
          if (l.includes(',')) {
            const rawNames = l.replace(/[*†‡§\d]/g, '').split(/[,;]|\band\b/i);
            for (const raw of rawNames) {
              const cleanName = raw.replace(/\s+/g, ' ').trim();
              const parts = cleanName.split(' ');
              if (
                parts.length >= 2 &&
                parts.length <= 4 &&
                parts.every((p) => /^[A-ZÀ-Ỹ]/.test(p))
              ) {
                parsedAuthors.push(cleanName);
              }
            }
          } else {
            const words = l
              .replace(/[*†‡§\d]/g, '')
              .split(/\s+/)
              .filter((w) => /^[A-ZÀ-Ỹ]/.test(w));
            for (let j = 0; j < words.length - 1; j += 2) {
              parsedAuthors.push(`${words[j]} ${words[j + 1]}`);
            }
          }
        }
      }

      if (parsedAuthors.length > 0) {
        metadata.authors = parsedAuthors;
      }
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
      buffer
        .subarray(0, PdfExtractorProvider.TEXT_SCAN_LIMIT)
        .toString('latin1'),
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
