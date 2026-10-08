import { Injectable, Logger, Optional } from '@nestjs/common';
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { isIP } from 'node:net';
import {
  AcademicCreator,
  BibliographicReference,
  DocumentSection,
  DocumentFigure,
  DocumentTable,
  DocumentFormula,
  DocumentHeaderResult,
} from '../../shared-kernel/types/bibliographic.types';
import { SsrfGuardService } from '../../shared-kernel/core/services/ssrf-guard.service';
import { cleanAbstractText } from '../../shared-kernel/utils/bibliographic.utils';
import { OcrProvider } from './ocr.provider';
import { OcrPageResult } from '../types/ocr.types';
import { TrustedExtractionService } from '../services/trusted-extraction.service';

export interface ExtractedPdfMetadata {
  doi?: string;
  isbn?: string;
  arxivId?: string;
  primaryCategory?: string;
  pmid?: string;
  title?: string;
  authors?: string[];
  creators?: AcademicCreator[];
  year?: number;
  publicationDate?: string;
  publisher?: string;
  repository?: string;
  numberOfPages?: number;
  abstract?: string;
  abstractParagraphs?: string[];
  abstractSections?: Array<{ heading?: string; text: string }>;
  keywords?: string[];
  notes?: Array<{ content: string; type?: string }>;
  journal?: string;
  bookTitle?: string;
  conferenceName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  place?: string;
  issn?: string;
  creationDate?: string;
  rawText?: string;
  rawTei?: string;
  referenceCount?: number;
  citationCount?: number;
  isSelfSufficient?: boolean;
  qualityScore?: number;
  engineUsed?: string;
}

export interface OcrPageProvenance {
  pageIndex: number;
  confidence: number;
  orientationAngle: number;
  skewAngle: number;
  preprocessed: boolean;
  textLength: number;
  lineCount: number;
  wordCount: number;
  executionTimeMs: number;
}

export interface OcrProvenanceData {
  totalOcrPages: number;
  avgConfidence: number;
  executionTimeMs: number;
  pages: OcrPageProvenance[];
}

export interface ExtractedPdfDocument {
  metadata: ExtractedPdfMetadata;
  pages: Array<{
    pageIndex: number;
    textContent: string;
    charOffset: number;
  }>;
  references?: BibliographicReference[];
  sections?: DocumentSection[];
  figures?: DocumentFigure[];
  tables?: DocumentTable[];
  formulas?: DocumentFormula[];
  ocrProvenance?: OcrProvenanceData;
  searchablePdfBuffer?: Buffer;
}

@Injectable()
export class PdfProvider {
  private readonly logger = new Logger(PdfProvider.name);
  public static readonly TEXT_SCAN_LIMIT = 50_000;

  constructor(
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional() private readonly ocrProvider?: OcrProvider,
    @Optional() private readonly trustedExtractor?: TrustedExtractionService,
  ) {}

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: { maxPages?: number; headerOnly?: boolean },
  ): Promise<ExtractedPdfDocument> {
    const pages: Array<{
      pageIndex: number;
      textContent: string;
      charOffset: number;
    }> = [];

    const ocrPageResults: OcrPageResult[] = [];
    const imageDimensionsMap = new Map<
      number,
      { width: number; height: number }
    >();

    // 1. Local-first In-Process Fast-Path: TrustedExtractionFacade (< 15ms)
    let trustedResult: any;
    const localStart = performance.now();

    if (this.trustedExtractor) {
      try {
        trustedResult = await this.trustedExtractor.extract(buffer);
      } catch (err: unknown) {
        this.logger.debug(
          `TrustedExtractor local execution skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const _localDurationMs = performance.now() - localStart;

    let combinedText = '';
    const unpdfExtractedMetadata: ExtractedPdfMetadata = {};

    // 2. Extract metadata from header stream first using safe regex before any parsing
    const headerExtractedMetadata = this.extractMetadataFromBuffer(buffer);

    // 3. Parse PDF via unpdf with an independent cloned Uint8Array to prevent buffer detachment
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

      const totalNumPages = document.numPages;
      unpdfExtractedMetadata.numberOfPages = totalNumPages;

      const configuredLimit = Number.parseInt(
        process.env.PDF_MAX_INDEX_PAGES || '0',
        10,
      );
      const requestedLimit = options?.headerOnly
        ? 3
        : options?.maxPages && options.maxPages > 0
          ? options.maxPages
          : configuredLimit > 0
            ? configuredLimit
            : totalNumPages;
      const maxPagesToExtract = Math.min(totalNumPages, requestedLimit);

      let currentOffset = 0;

      for (let pageIndex = 1; pageIndex <= maxPagesToExtract; pageIndex++) {
        const page = await document.getPage(pageIndex);
        const content = await page.getTextContent();
        let pageText = content.items
          .map((it: any) => (it.str || '') + (it.hasEOL ? '\n' : ' '))
          .join('');

        const scanDetection = this.ocrProvider?.detectScannedPage
          ? await this.ocrProvider.detectScannedPage(page, content)
          : {
              isScanned: pageText.replace(/\s/g, '').length < 32,
              isHybrid: false,
            };

        const shouldOcr =
          this.ocrProvider?.enabled &&
          (scanDetection.isScanned || scanDetection.isHybrid) &&
          pageIndex <= this.ocrProvider.maxPages;

        if (shouldOcr) {
          const res = await this.ocrProvider.recognizePdfPage(
            page,
            pageIndex - 1,
          );
          if (res) {
            const rawOcrText = typeof res === 'string' ? res : res.text;
            if (scanDetection.isHybrid) {
              if (rawOcrText && rawOcrText.length > pageText.length) {
                pageText = rawOcrText;
              }
            } else if (rawOcrText) {
              pageText = rawOcrText;
            }
            if (typeof res !== 'string' && res.wasOcr) {
              ocrPageResults.push(res);
              if (typeof page.getViewport === 'function') {
                try {
                  const viewport = page.getViewport({ scale: 2 });
                  imageDimensionsMap.set(pageIndex - 1, {
                    width: viewport.width,
                    height: viewport.height,
                  });
                } catch {
                  // ignore
                }
              }
            }
          }
        }

        pages.push({
          pageIndex: pageIndex - 1,
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

    const textExtractedMetadata = combinedText
      ? this.extractMetadataFromText(combinedText)
      : {};

    const metadata: ExtractedPdfMetadata = {
      doi:
        trustedResult?.metadata?.doi ||
        textExtractedMetadata.doi ||
        unpdfExtractedMetadata.doi ||
        headerExtractedMetadata.doi,
      isbn:
        trustedResult?.metadata?.isbn ||
        textExtractedMetadata.isbn ||
        unpdfExtractedMetadata.isbn ||
        headerExtractedMetadata.isbn,
      publisher:
        trustedResult?.metadata?.publisher ||
        textExtractedMetadata.publisher ||
        unpdfExtractedMetadata.publisher,
      numberOfPages: unpdfExtractedMetadata.numberOfPages,
      arxivId:
        trustedResult?.metadata?.arxivId ||
        textExtractedMetadata.arxivId ||
        unpdfExtractedMetadata.arxivId ||
        headerExtractedMetadata.arxivId,
      title:
        trustedResult?.metadata?.title ||
        (unpdfExtractedMetadata.title &&
        unpdfExtractedMetadata.title.length > 8 &&
        !/^(untitled|document|microsoft|arxiv|\d{4}\.)/i.test(
          unpdfExtractedMetadata.title,
        )
          ? unpdfExtractedMetadata.title
          : textExtractedMetadata.title) ||
        textExtractedMetadata.title ||
        unpdfExtractedMetadata.title ||
        (headerExtractedMetadata.title &&
        !headerExtractedMetadata.title.toLowerCase().endsWith('.pdf') &&
        !/^\d{4}\.\d{4,5}/.test(headerExtractedMetadata.title) &&
        headerExtractedMetadata.title.length > 5
          ? headerExtractedMetadata.title
          : undefined),
      authors:
        trustedResult?.metadata?.authors &&
        trustedResult.metadata.authors.length > 0
          ? trustedResult.metadata.authors
          : textExtractedMetadata.authors &&
              textExtractedMetadata.authors.length > 0
            ? textExtractedMetadata.authors
            : unpdfExtractedMetadata.authors &&
                unpdfExtractedMetadata.authors.length > 0
              ? unpdfExtractedMetadata.authors
              : headerExtractedMetadata.authors,
      creators:
        trustedResult?.metadata?.creators ||
        (trustedResult?.metadata?.authors &&
        trustedResult.metadata.authors.length > 0
          ? trustedResult.metadata.authors.map((a: string, idx: number) => ({
              orderIndex: idx,
              creatorType: 'author',
              fullName: a,
            }))
          : undefined),
      year:
        trustedResult?.metadata?.year ||
        textExtractedMetadata.year ||
        unpdfExtractedMetadata.year ||
        headerExtractedMetadata.year,
      abstract:
        trustedResult?.metadata?.abstract ||
        cleanAbstractText(headerExtractedMetadata.abstract) ||
        cleanAbstractText(textExtractedMetadata.abstract) ||
        undefined,
      keywords:
        trustedResult?.metadata?.keywords ||
        (textExtractedMetadata.keywords &&
        textExtractedMetadata.keywords.length > 0
          ? textExtractedMetadata.keywords
          : unpdfExtractedMetadata.keywords &&
              unpdfExtractedMetadata.keywords.length > 0
            ? unpdfExtractedMetadata.keywords
            : headerExtractedMetadata.keywords),
      rawText: combinedText.slice(0, PdfProvider.TEXT_SCAN_LIMIT),
      isSelfSufficient: trustedResult?.isSelfSufficient,
      qualityScore: trustedResult?.quality?.totalScore,
      engineUsed: trustedResult?.provenance?.engineUsed,
    };

    const references: BibliographicReference[] = [];
    const sections: DocumentSection[] = [];
    const figures: DocumentFigure[] = [];
    const tables: DocumentTable[] = [];
    const formulas: DocumentFormula[] = [];

    let searchablePdfBuffer: Buffer | undefined;

    if (ocrPageResults.length > 0 && this.ocrProvider?.generateSearchablePdf) {
      try {
        searchablePdfBuffer = await this.ocrProvider.generateSearchablePdf(
          buffer,
          ocrPageResults,
          imageDimensionsMap,
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to generate sandwich PDF: ${err?.message || err}`,
        );
      }
    }

    if (references && references.length > 0) {
      metadata.referenceCount = references.length;
    }

    let ocrProvenance: OcrProvenanceData | undefined;
    if (ocrPageResults.length > 0) {
      const avgConfidence =
        ocrPageResults.reduce(
          (acc: number, p: OcrPageResult) => acc + p.confidence,
          0,
        ) / ocrPageResults.length;
      const totalExecTime = ocrPageResults.reduce(
        (acc: number, p: OcrPageResult) => acc + p.executionTimeMs,
        0,
      );

      ocrProvenance = {
        totalOcrPages: ocrPageResults.length,
        avgConfidence: Math.round(avgConfidence * 10) / 10,
        executionTimeMs: totalExecTime,
        pages: ocrPageResults.map((p: OcrPageResult) => ({
          pageIndex: p.pageIndex,
          confidence: Math.round(p.confidence * 10) / 10,
          orientationAngle: p.orientationAngle,
          skewAngle: p.skewAngle,
          preprocessed: p.preprocessed,
          textLength: p.text.length,
          lineCount: p.blocks.reduce(
            (acc: number, b: any) => acc + (b.lines?.length || 0),
            0,
          ),
          wordCount: p.words.length,
          executionTimeMs: p.executionTimeMs,
        })),
      };
    }

    return {
      metadata,
      pages,
      references,
      sections,
      figures,
      tables,
      formulas,
      ocrProvenance,
      searchablePdfBuffer,
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
        /arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)(?:\s*\[([a-zA-Z-]+(?:\.[a-zA-Z-]+)?)\])?/i,
      );
      if (arxivMatchResult) {
        extractedMetadataResult.arxivId = arxivMatchResult[1];
        if (arxivMatchResult[2]) {
          extractedMetadataResult.primaryCategory = arxivMatchResult[2];
        }
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
    const joinedText = scannedText
      .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
      .replace(/(10\.\d{4,9}\/)\s+/g, '$1');
    const doiMatches =
      joinedText.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/g) ?? [];

    for (const match of doiMatches) {
      const doi = match.replace(/[.,;)\]]+$/, '');
      if (/n{4,}/i.test(doi)) continue;
      return doi;
    }

    const arxivMatch = scannedText.match(
      /(?:arxiv:?\s*|\barxiv\.org\/(?:abs|pdf)\/|\b)([0-2][0-9]{3}\.[0-9]{4,5}(?:v[0-9]+)?)\b/i,
    );
    return arxivMatch?.[1] ? `10.48550/arXiv.${arxivMatch[1]}` : null;
  }

  extractMetadataFromText(text: string): ExtractedPdfMetadata {
    const scannedText = text.slice(0, PdfProvider.TEXT_SCAN_LIMIT);
    const metadata: ExtractedPdfMetadata = {};
    const doi = this.extractFromText(
      scannedText
        .replace(/(10\.\d{4,9})\s*\/\s*/g, '$1/')
        .replace(/(10\.\d{4,9}\/)\s*\n\s*/g, '$1'),
    );
    if (doi) metadata.doi = doi;

    const arxivMatch = scannedText.match(
      /(?:arxiv[:\s._/-]+)([0-2]\d{3}\.\d{4,5}(?:v\d+)?)(?:\s*\[([a-zA-Z-]+(?:\.[a-zA-Z-]+)?)\])?/i,
    );
    if (arxivMatch?.[1]) {
      metadata.arxivId = arxivMatch[1];
      if (arxivMatch[2]) {
        metadata.primaryCategory = arxivMatch[2];
      }
    } else {
      const standalone = scannedText
        .slice(0, 2000)
        .match(/\b([0-2][0-9]{3}\.[0-9]{4,5}(?:v[0-9]+)?)\b/);
      if (standalone?.[1]) metadata.arxivId = standalone[1];
    }

    const isbnMatch = scannedText.match(
      /(?:ISBN(?:-1[03])?:?\s*)([0-9Xx\s-]{10,20})/i,
    );
    if (isbnMatch) {
      const cleanIsbn = isbnMatch[1].replace(/[-\s]/g, '').trim();
      if (cleanIsbn.length === 10 || cleanIsbn.length === 13) {
        metadata.isbn = cleanIsbn;
      }
    }

    const pubMatch = scannedText.match(
      /\b(Cambridge University Press|Springer(?:-Verlag)?|MIT Press|Prentice Hall|Stanford University(?: Press)?|Oxford University Press|IEEE|ACM|Elsevier|Wiley)\b/i,
    );
    if (pubMatch) {
      metadata.publisher = pubMatch[1].trim();
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
        /^(arxiv[:\s._/-]*\d|https?:\/\/|\d+$|submitted to|accepted (as|at)|published as|proceedings of|ieee|acm|springer|elsevier|under review|provided proper)/i.test(
          lineItem,
        )
      )
        return false;
      if (
        /reproduce the tables and figures|permission to|copyright|all rights reserved|doi:\s*10\.|scholarly works/i.test(
          lineItem,
        )
      )
        return false;
      if (/^\d+\s*\|\s*[a-z]/i.test(lineItem)) return false;
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
        const nextLine = cleanLines[lineIndex + 1];
        const nextIsContinuation = Boolean(
          nextLine &&
          /^(for|by|and|with|in|on|using|via|under|towards|from|to|of)\b/i.test(
            nextLine.trim(),
          ),
        );
        const endsWithHyphen = currentLine.trim().endsWith('-');
        if (
          !endsWithHyphen &&
          !nextIsContinuation &&
          (currentLine.length >= 40 || titleLines.length >= 2)
        ) {
          authorStartIndex = lineIndex + 1;
          break;
        }
      }

      const rawTitle = titleLines
        .filter((l, i, arr) => arr.indexOf(l) === i)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const candidateTitle = rawTitle
        .replace(/\b([A-Z])\s+([A-Z]{2,})\b/g, '$1$2')
        .replace(/\b([B-HJ-Z])\s+([A-Z])\b/g, '$1$2')
        .replace(/\b([A-Za-z0-9]+)\s+-\s+([A-Za-z0-9]+)\b/g, '$1-$2')
        .replace(/\b([A-Za-z])\s+([A-Za-z])\b/g, '$1$2')
        .replace(/-\s+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
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
            /^(for|by|and|with|using|towards|under)\s+[A-Z]/i.test(
              authorLine.trim(),
            )
          ) {
            continue;
          }
          if (
            /@|univ|institute|department|college|laboratory|school|hospital|center|research|microsoft|google/i.test(
              authorLine,
            )
          ) {
            continue;
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
      buffer.subarray(0, PdfProvider.TEXT_SCAN_LIMIT).toString('latin1'),
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
