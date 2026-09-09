import { Injectable, Logger, Optional } from '@nestjs/common';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { isIP } from 'node:net';
import {
  GrobidClient,
  GrobidCreator,
  GrobidReference,
  GrobidSection,
  GrobidFigure,
  GrobidTable,
  GrobidFormula,
} from '../../../../infra/grobid/grobid.client';
import { SsrfGuardService } from '../../common/services/ssrf-guard.service';
import { cleanAbstractText } from '../../items/utils/items.utils';

export interface ExtractedPdfMetadata {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  title?: string;
  authors?: string[];
  creators?: GrobidCreator[];
  year?: number;
  publicationDate?: string;
  abstract?: string;
  abstractParagraphs?: string[];
  abstractSections?: Array<{ heading?: string; text: string }>;
  keywords?: string[];
  journal?: string;
  creationDate?: string;
  rawText?: string;
  rawTei?: string;
}

export interface ExtractedPdfDocument {
  metadata: ExtractedPdfMetadata;
  pages: Array<{
    pageIndex: number;
    textContent: string;
    charOffset: number;
  }>;
  references?: GrobidReference[];
  sections?: GrobidSection[];
  figures?: GrobidFigure[];
  tables?: GrobidTable[];
  formulas?: GrobidFormula[];
}

@Injectable()
export class PdfProvider {
  private readonly logger = new Logger(PdfProvider.name);
  public static readonly TEXT_SCAN_LIMIT = 50_000;

  constructor(
    @Optional() private readonly grobidClient?: GrobidClient,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
  ) {}

  async extractDocumentFromBuffer(
    buffer: Buffer,
  ): Promise<ExtractedPdfDocument> {
    const pages: Array<{
      pageIndex: number;
      textContent: string;
      charOffset: number;
    }> = [];

    let combinedText = '';
    const unpdfExtractedMetadata: ExtractedPdfMetadata = {};

    // 1. Extract metadata from header stream first using safe regex before any parsing
    const headerExtractedMetadata = this.extractMetadataFromBuffer(buffer);

    // 2. Parse PDF via unpdf with an independent cloned Uint8Array to prevent buffer detachment
    try {
      const clonedBinaryDataArray = new Uint8Array(buffer.byteLength);
      clonedBinaryDataArray.set(buffer);

      const document = await getDocumentProxy(clonedBinaryDataArray);

      try {
        const documentInformation = await getMeta(document);
        if (documentInformation?.info) {
          const informationRecord = documentInformation.info;
          if (typeof informationRecord.Title === 'string') {
            const cleanTitle = informationRecord.Title.trim();
            if (
              cleanTitle.length > 5 &&
              !cleanTitle.toLowerCase().endsWith('.pdf') &&
              !/^(untitled|document|microsoft word)/i.test(cleanTitle)
            ) {
              unpdfExtractedMetadata.title = cleanTitle;
            }
          }
          if (typeof informationRecord.Author === 'string') {
            const cleanAuthor = informationRecord.Author.trim();
            if (
              cleanAuthor.length > 2 &&
              !/^(administrator|user|owner|unknown)$/i.test(cleanAuthor)
            ) {
              const authorList = cleanAuthor
                .split(/[,;\n]|\band\b/i)
                .map((authorItem: string) => authorItem.trim())
                .filter(
                  (authorItem: string) =>
                    authorItem.length > 1 && !/^\d+$/.test(authorItem),
                );
              if (authorList.length > 0) {
                unpdfExtractedMetadata.authors = authorList;
              }
            }
          }
          if (typeof informationRecord.CreationDate === 'string') {
            const yearMatch = informationRecord.CreationDate.match(/D:(\d{4})/);
            if (yearMatch?.[1]) {
              unpdfExtractedMetadata.year = parseInt(yearMatch[1], 10);
            }
          }
          if (typeof informationRecord.Keywords === 'string') {
            const keywordList = informationRecord.Keywords.split(/[,;]/)
              .map((keywordItem: string) => keywordItem.trim())
              .filter(Boolean);
            if (keywordList.length > 0) {
              unpdfExtractedMetadata.keywords = keywordList;
            }
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
      for (let pageIndex = 0; pageIndex < rawPages.length; pageIndex++) {
        const pageText = rawPages[pageIndex] || '';
        pages.push({
          pageIndex: pageIndex,
          textContent: pageText,
          charOffset: currentOffset,
        });
        currentOffset += pageText.length + 1;
        combinedText += (combinedText ? '\n' : '') + pageText;
      }
    } catch (caughtError: unknown) {
      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError);
      this.logger.warn(
        `PDF unpdf parse failed (encrypted or corrupted): ${errorMessage}`,
      );
    }

    // 3. Extract metadata from combined text
    const textExtractedMetadata = combinedText
      ? this.extractMetadataFromText(combinedText)
      : {};

    const metadata: ExtractedPdfMetadata = {
      doi:
        textExtractedMetadata.doi ||
        unpdfExtractedMetadata.doi ||
        headerExtractedMetadata.doi,
      arxivId:
        textExtractedMetadata.arxivId ||
        unpdfExtractedMetadata.arxivId ||
        headerExtractedMetadata.arxivId,
      title:
        textExtractedMetadata.title ||
        unpdfExtractedMetadata.title ||
        (headerExtractedMetadata.title &&
        !headerExtractedMetadata.title.toLowerCase().endsWith('.pdf') &&
        !/^\d{4}\.\d{4,5}/.test(headerExtractedMetadata.title) &&
        headerExtractedMetadata.title.length > 5
          ? headerExtractedMetadata.title
          : undefined),
      authors:
        textExtractedMetadata.authors &&
        textExtractedMetadata.authors.length > 0
          ? textExtractedMetadata.authors
          : unpdfExtractedMetadata.authors &&
              unpdfExtractedMetadata.authors.length > 0
            ? unpdfExtractedMetadata.authors
            : headerExtractedMetadata.authors,
      year:
        textExtractedMetadata.year ||
        unpdfExtractedMetadata.year ||
        headerExtractedMetadata.year,
      abstract:
        cleanAbstractText(headerExtractedMetadata.abstract) ||
        cleanAbstractText(textExtractedMetadata.abstract) ||
        undefined,
      keywords:
        textExtractedMetadata.keywords &&
        textExtractedMetadata.keywords.length > 0
          ? textExtractedMetadata.keywords
          : unpdfExtractedMetadata.keywords &&
              unpdfExtractedMetadata.keywords.length > 0
            ? unpdfExtractedMetadata.keywords
            : headerExtractedMetadata.keywords,
      rawText: combinedText.slice(0, PdfProvider.TEXT_SCAN_LIMIT),
    };

    // ── GROBID: Authoritative ML Document Layout & Full-Text Zoning ──────────
    // GROBID uses 2D spatial coordinates and CRF sequence labelling to segment
    // the header, sections, tables, figures, formulas, and bibliographic citations.
    let references: GrobidReference[] = [];
    let sections: GrobidSection[] = [];
    let figures: GrobidFigure[] = [];
    let tables: GrobidTable[] = [];
    let formulas: GrobidFormula[] = [];

    if (this.grobidClient) {
      try {
        const fulltextResult =
          await this.grobidClient.processFulltextDocument(buffer);
        if (fulltextResult) {
          const header = fulltextResult.header;
          if (header.abstract) {
            const cleanGrobidAbstract = cleanAbstractText(header.abstract);
            if (cleanGrobidAbstract) {
              metadata.abstract = cleanGrobidAbstract;
            }
            metadata.abstractParagraphs = header.abstractParagraphs;
            metadata.abstractSections = header.abstractSections;
          }
          if (header.title) {
            metadata.title = header.title;
          }
          if (header.creators && header.creators.length > 0) {
            metadata.creators = header.creators;
            metadata.authors = header.creators.map((c) => c.fullName);
          } else if (header.authors && header.authors.length > 0) {
            metadata.authors = header.authors;
          }
          if (header.doi) {
            metadata.doi = header.doi;
          }
          if (header.arxivId) {
            metadata.arxivId = header.arxivId;
          }
          if (header.keywords && header.keywords.length > 0) {
            metadata.keywords = header.keywords;
          }
          if (header.year) {
            metadata.year = header.year;
          }
          if (header.publicationDate) {
            metadata.publicationDate = header.publicationDate;
          }
          if (header.journal) {
            metadata.journal = header.journal;
          }
          if (header.rawTei) {
            metadata.rawTei = header.rawTei;
          }

          sections = fulltextResult.sections || [];
          figures = fulltextResult.figures || [];
          tables = fulltextResult.tables || [];
          formulas = fulltextResult.formulas || [];
          references = fulltextResult.references || [];

          this.logger.debug(
            `GROBID fulltext parsed: ${sections.length} sections, ${figures.length} figures, ${tables.length} tables, ${formulas.length} formulas, ${references.length} references`,
          );
        } else {
          // Fallback to header + references if fulltext returned null
          const headerResult =
            await this.grobidClient.processHeaderDocument(buffer);
          if (headerResult) {
            if (headerResult.abstract)
              metadata.abstract = headerResult.abstract;
            if (headerResult.title) metadata.title = headerResult.title;
            if (headerResult.creators && headerResult.creators.length > 0) {
              metadata.creators = headerResult.creators;
              metadata.authors = headerResult.creators.map((c) => c.fullName);
            }
            if (headerResult.doi) metadata.doi = headerResult.doi;
            if (headerResult.arxivId) metadata.arxivId = headerResult.arxivId;
            if (headerResult.rawTei) metadata.rawTei = headerResult.rawTei;
          }
          references = await this.grobidClient.processReferences(buffer);
        }
      } catch (caughtError: unknown) {
        const errorMessage =
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError);
        this.logger.warn(
          `GROBID extraction failed (falling back to unpdf heuristics): ${errorMessage}`,
        );
      }
    }

    return {
      metadata,
      pages,
      references,
      sections,
      figures,
      tables,
      formulas,
    };
  }

  async extractMetadataFromUrl(fileUrl: string): Promise<ExtractedPdfMetadata> {
    try {
      const guard = this.ssrfGuard || new SsrfGuardService();
      const response = await guard.safeFetch(fileUrl, {
        headers: { 'User-Agent': 'Flux-Extractor/1.0' },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch PDF from URL: ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const extractedDocument = await this.extractDocumentFromBuffer(buffer);
      return extractedDocument.metadata;
    } catch (caughtError: unknown) {
      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError);
      this.logger.warn(`Remote PDF extraction failed: ${errorMessage}`);
      return {};
    }
  }

  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata {
    if (!buffer || buffer.length === 0) {
      return {};
    }

    try {
      const rawHeaderStream = buffer.subarray(0, 32768).toString('latin1');
      const extractedMetadataResult: ExtractedPdfMetadata = {};

      const doiMatchResult = rawHeaderStream.match(
        /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/,
      );
      if (doiMatchResult) {
        extractedMetadataResult.doi = doiMatchResult[0].replace(
          /[.,;)\]]+$/,
          '',
        );
      }

      const arxivMatchResult = rawHeaderStream.match(
        /arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i,
      );
      if (arxivMatchResult) {
        extractedMetadataResult.arxivId = arxivMatchResult[1];
      }

      const titleMatchResult = rawHeaderStream.match(/\/Title\s*\(([^)]+)\)/);
      if (titleMatchResult && titleMatchResult[1]) {
        extractedMetadataResult.title = titleMatchResult[1].trim();
      }

      const authorMatchResult = rawHeaderStream.match(/\/Author\s*\(([^)]+)\)/);
      if (authorMatchResult && authorMatchResult[1]) {
        extractedMetadataResult.authors = [authorMatchResult[1].trim()];
      }

      const dateMatchResult = rawHeaderStream.match(
        /\/CreationDate\s*\(D:(\d{4})/,
      );
      if (dateMatchResult && dateMatchResult[1]) {
        extractedMetadataResult.year = parseInt(dateMatchResult[1], 10);
      }

      return extractedMetadataResult;
    } catch {
      return {};
    }
  }

  extractFromText(text: string): string | null {
    if (!text) return null;

    const scannedText = text.slice(0, PdfProvider.TEXT_SCAN_LIMIT);
    const joinedText = scannedText.replace(/(10\.\d{4,9}\/)\s+/g, '$1');
    const doiMatches =
      joinedText.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g) ?? [];

    for (const match of doiMatches) {
      const doi = match.replace(/[.,;)\]]+$/, '');
      if (/n{4,}/i.test(doi)) continue;
      return doi;
    }

    const arxivMatch = scannedText.match(/arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    return arxivMatch?.[1] ? `10.48550/arXiv.${arxivMatch[1]}` : null;
  }

  extractMetadataFromText(text: string): ExtractedPdfMetadata {
    const scannedText = text.slice(0, PdfProvider.TEXT_SCAN_LIMIT);
    const metadata: ExtractedPdfMetadata = {};
    const doi = this.extractFromText(
      scannedText.replace(/(10\.\d{4,9}\/)\s*\n\s*/g, '$1'),
    );
    if (doi) metadata.doi = doi;

    const arxivMatch = scannedText.match(
      /(?:arxiv[:\s._/-]+)(\d{4}\.\d{4,5}(?:v\d+)?)/i,
    );
    if (arxivMatch?.[1]) {
      metadata.arxivId = arxivMatch[1];
    } else {
      const standalone = scannedText
        .slice(0, 1500)
        .match(/\b(1[0-9]{3}\.[0-9]{4,5}(?:v[0-9]+)?)\b/);
      if (standalone?.[1]) metadata.arxivId = standalone[1];
    }

    const abstractMatch = scannedText.match(
      /(?:^|\n)\s*(?:Abstract|ABSTRACT|Summary|Résumé)[—:\-\s.]*\s*([\s\S]*?)(?=(?:\n\s*(?:Index Terms|Keywords|Key\s*words|1\.?\s+[A-Z]|I\.?\s+[A-Z]|INTRODUCTION|Contents|Background|1\b|I\b))|(?:\r?\n\s*\r?\n\s*(?:[A-Z0-9\s]{3,30}\n|1\.|\bI\b))|$)/i,
    );
    if (abstractMatch?.[1]) {
      let candidate = abstractMatch[1].trim();
      const doubleBreakIdx = candidate.search(
        /\r?\n\s*\r?\n\s*(?:[0-9IVX]+\b|[A-Z\s]{4,}\b)/,
      );
      if (doubleBreakIdx > 50) {
        candidate = candidate.slice(0, doubleBreakIdx);
      } else if (candidate.length > 1800) {
        const sentenceEnd = candidate.slice(0, 1500).lastIndexOf('.');
        if (sentenceEnd > 200) {
          candidate = candidate.slice(0, sentenceEnd + 1);
        } else {
          candidate = candidate.slice(0, 1500);
        }
      }
      const cleanAbstract = cleanAbstractText(candidate);
      if (cleanAbstract && cleanAbstract.length > 15) {
        metadata.abstract = cleanAbstract;
      }
    }

    const keywordsMatch = scannedText.match(
      /(?:Index Terms|Keywords)[—:\-\s]+([^\n.]+)/i,
    );
    if (keywordsMatch?.[1]) {
      metadata.keywords = keywordsMatch[1]
        .split(/[,;]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean);
    }

    // Extract Title and Authors from first page header lines
    const lines = scannedText
      .split('\n')
      .map((lineItem) => lineItem.trim())
      .filter(Boolean);

    let abstractIndex = -1;
    for (
      let lineIndex = 0;
      lineIndex < Math.min(lines.length, 60);
      lineIndex++
    ) {
      if (/^abstract\b/i.test(lines[lineIndex])) {
        abstractIndex = lineIndex;
        break;
      }
    }

    const headerLines =
      abstractIndex !== -1 ? lines.slice(0, abstractIndex) : lines.slice(0, 25);
    const cleanLines = headerLines.filter((lineItem) => {
      if (
        /^(arxiv[:\s._/-]*\d|https?:\/\/|\d+$|submitted to|accepted (as|at)|proceedings of|ieee|acm|springer|elsevier)/i.test(
          lineItem,
        )
      )
        return false;
      if (/copyright|all rights reserved|doi:\s*10\./i.test(lineItem))
        return false;
      return true;
    });

    if (cleanLines.length > 0) {
      const titleLines: string[] = [];
      let authorStartIndex = -1;

      for (let lineIndex = 0; lineIndex < cleanLines.length; lineIndex++) {
        const currentLine = cleanLines[lineIndex];
        if (
          /@|univ|institute|department|college|laboratory|school|hospital|center/i.test(
            currentLine,
          )
        ) {
          if (authorStartIndex === -1) authorStartIndex = lineIndex;
          break;
        }
        const hasCommaOrAnd = /(?:,|\band\b)/i.test(currentLine);
        const wordsInLine = currentLine.split(/\s+/);
        const looksLikeMultipleNames =
          wordsInLine.length >= 4 &&
          wordsInLine.every(
            (wordItem) =>
              /^[A-ZÀ-Ỹ]/.test(wordItem) || /[*†‡§\d]/.test(wordItem),
          );

        if (
          titleLines.length > 0 &&
          (hasCommaOrAnd || looksLikeMultipleNames)
        ) {
          authorStartIndex = lineIndex;
          break;
        }

        titleLines.push(currentLine);
        if (currentLine.length >= 25 || titleLines.length >= 2) {
          authorStartIndex = lineIndex + 1;
          break;
        }
      }

      const candidateTitle = titleLines.join(' ').replace(/\s+/g, ' ').trim();
      if (candidateTitle.length > 5 && candidateTitle.length < 250) {
        metadata.title = candidateTitle;
      }

      const parsedAuthors: string[] = [];
      if (authorStartIndex !== -1 && authorStartIndex < cleanLines.length) {
        for (
          let lineIndex = authorStartIndex;
          lineIndex < cleanLines.length;
          lineIndex++
        ) {
          const authorLine = cleanLines[lineIndex];
          if (
            /@|univ|institute|department|college|laboratory|school|hospital|center|research|microsoft|google/i.test(
              authorLine,
            )
          ) {
            break;
          }
          if (authorLine.includes(',')) {
            const rawAuthorNames = authorLine
              .replace(/[*†‡§\d]/g, '')
              .split(/[,;]|\band\b/i);
            for (const rawAuthorName of rawAuthorNames) {
              const cleanName = rawAuthorName.replace(/\s+/g, ' ').trim();
              const nameParts = cleanName.split(' ');
              if (
                nameParts.length >= 2 &&
                nameParts.length <= 4 &&
                nameParts.every((partItem) => /^[A-ZÀ-Ỹ]/.test(partItem))
              ) {
                parsedAuthors.push(cleanName);
              }
            }
          } else {
            const nameWords = authorLine
              .replace(/[*†‡§\d]/g, '')
              .split(/\s+/)
              .filter((wordItem) => /^[A-ZÀ-Ỹ]/.test(wordItem));
            for (
              let wordIndex = 0;
              wordIndex < nameWords.length - 1;
              wordIndex += 2
            ) {
              parsedAuthors.push(
                `${nameWords[wordIndex]} ${nameWords[wordIndex + 1]}`,
              );
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
      const extractedDocument = await this.extractDocumentFromBuffer(buffer);
      if (extractedDocument.metadata.doi) return extractedDocument.metadata.doi;
    } catch (caughtError: unknown) {
      const errorMessage =
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError);
      this.logger.warn(`extractFromBuffer failed: ${errorMessage}`);
    }

    return this.extractFromText(
      buffer
        .subarray(0, PdfProvider.TEXT_SCAN_LIMIT)
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

export { PdfProvider as PdfExtractorProvider };
