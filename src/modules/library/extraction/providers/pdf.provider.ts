import { Injectable, Logger, Optional } from '@nestjs/common';
import { getDocumentProxy, getMeta } from 'unpdf';
import {
  DocumentSection,
} from '@/modules/library/core/types/bibliographic.types';
import {
  cleanAbstractText,
  libraryConfig,
  ExtractedPdfMetadata,
  ExtractedPdfDocument,
  PdfMetadataExtractionResult,
} from '@/modules/library/core';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import { PdfMetadataExtractor } from '@/modules/library/extraction/services/pdf-metadata.extractor';
import { LayoutExtractor } from '@/modules/library/extraction/extractors/layout.extractor';
import {
  PdfTextMetadataExtractor,
  extractPdfOutlineSections,
} from './pdf-text-metadata.extractor';

export type {
  ExtractedPdfMetadata,
  ExtractedPdfDocument,
};

@Injectable()
export class PdfProvider {
  private readonly logger = new Logger(PdfProvider.name);
  public static readonly TEXT_SCAN_LIMIT = 50_000;

  constructor(
    @Optional() private readonly trustedExtractor?: PdfMetadataExtractor,
    @Optional()
    private readonly textMetadataExtractor: PdfTextMetadataExtractor = new PdfTextMetadataExtractor(),
  ) {}

  async extractDocumentFromBuffer(
    buffer: Buffer,
    options?: {
      maxPages?: number;
      headerOnly?: boolean;
      skipTrustedExtraction?: boolean;
    },
  ): Promise<ExtractedPdfDocument> {
    const pages: Array<{
      pageIndex: number;
      pageNumber?: number;
      textContent: string;
      text?: string;
      charOffset: number;
    }> = [];
    let extractedSections: DocumentSection[] = [];

    // 1. Parse PDF via unpdf once with an independent cloned Uint8Array to prevent buffer detachment
    let sharedDocumentProxy:
      Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      const clonedBinaryDataArray = new Uint8Array(buffer.byteLength);
      clonedBinaryDataArray.set(buffer);
      sharedDocumentProxy = await getDocumentProxy(clonedBinaryDataArray);
    } catch {
      // Non-fatal: individual stages handle unparseable buffers gracefully
    }

    let fallbackDocumentProxy:
      Awaited<ReturnType<typeof getDocumentProxy>> | undefined;

    try {
      // 2. Local-first In-Process Fast-Path: TrustedExtractionFacade (< 15ms)
      let trustedResult: PdfMetadataExtractionResult | undefined;
      const localStart = performance.now();

      if (this.trustedExtractor && !options?.skipTrustedExtraction) {
        try {
          trustedResult = await this.trustedExtractor.extract(
            buffer,
            undefined,
            sharedDocumentProxy,
          );
        } catch (err: unknown) {
          this.logger.debug(
            `TrustedExtractor local execution skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const _localDurationMs = performance.now() - localStart;

      let combinedText = '';
      const unpdfExtractedMetadata: ExtractedPdfMetadata = {};

      // 3. Extract metadata from buffer using pdf-lib + safe decoded fallback ONLY if trustedExtractor did not already run
      const headerExtractedMetadata = trustedResult
        ? {}
        : await this.extractMetadataFromBufferAsync(buffer);

      // 4. Reuse pre-parsed PDF document proxy (or fallback to getDocumentProxy)
      try {
        const document =
          sharedDocumentProxy ??
          (fallbackDocumentProxy = await (async () => {
            // Zero-copy TypedArray view over existing buffer ArrayBuffer (avoids duplicating multi-megabyte buffers on V8 heap)
            const binaryDataView = new Uint8Array(
              buffer.buffer,
              buffer.byteOffset,
              buffer.byteLength,
            );
            return getDocumentProxy(binaryDataView);
          })());

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
              const yearMatch =
                informationRecord.CreationDate.match(/D:(\d{4})/);
              if (yearMatch?.[1]) {
                unpdfExtractedMetadata.year = parseInt(yearMatch[1], 10);
              }
            }
            if (typeof informationRecord.Keywords === 'string') {
              const keywordList = normalizeTags([informationRecord.Keywords]);
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

        const configuredLimit = libraryConfig().extraction.pdfMaxIndexPages;
        const requestedLimit = options?.headerOnly
          ? 3
          : options?.maxPages && options.maxPages > 0
            ? options.maxPages
            : configuredLimit > 0
              ? configuredLimit
              : totalNumPages;
        const maxPagesToExtract = Math.min(totalNumPages, requestedLimit);

        const processSinglePage = async (
          pageNumber: number,
        ): Promise<{
          pageIndex: number;
          pageNumber: number;
          pageText: string;
        }> => {
          const page = await document.getPage(pageNumber);
          try {
            const content = (await page.getTextContent()) as {
              items: Array<{ str?: string; hasEOL?: boolean }>;
            };
            const pageText = content.items
              .map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' '))
              .join('');

            return {
              pageIndex: pageNumber - 1,
              pageNumber,
              pageText,
            };
          } finally {
            try {
              page?.cleanup?.();
            } catch {
              // Ignore page cleanup errors
            }
          }
        };

        const rawPageOutputs: Array<
          Awaited<ReturnType<typeof processSinglePage>>
        > = new Array(maxPagesToExtract);

        const PAGE_EXTRACTION_CONCURRENCY = 4;
        for (
          let batchStart = 1;
          batchStart <= maxPagesToExtract;
          batchStart += PAGE_EXTRACTION_CONCURRENCY
        ) {
          const batchEnd = Math.min(
            maxPagesToExtract,
            batchStart + PAGE_EXTRACTION_CONCURRENCY - 1,
          );
          const batchPromises: Array<Promise<void>> = [];
          for (let pageNum = batchStart; pageNum <= batchEnd; pageNum++) {
            batchPromises.push(
              processSinglePage(pageNum).then((res) => {
                rawPageOutputs[pageNum - 1] = res;
              }),
            );
          }
          await Promise.all(batchPromises);
        }

        let currentOffset = 0;
        const pageTextChunks: string[] = [];
        for (const out of rawPageOutputs) {
          if (!out) continue;
          pages.push({
            pageIndex: out.pageIndex,
            pageNumber: out.pageNumber,
            textContent: out.pageText,
            text: out.pageText,
            charOffset: currentOffset,
          });
          currentOffset += out.pageText.length + 1;
          pageTextChunks.push(out.pageText);
        }
        combinedText = pageTextChunks.join('\n');

        // Extract outline/bookmarks or fallback to heading regex heuristics on extracted pages
        extractedSections = await this.extractOutlineSections(document, pages);
      } catch (caughtError: unknown) {
        const errorMessage =
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError);
        this.logger.warn(
          `PDF unpdf parse failed (encrypted or corrupted): ${errorMessage}`,
        );
      }

      const needsFallbackTextMetadataScan =
        !trustedResult?.isSelfSufficient ||
        !trustedResult?.metadata?.abstract ||
        !trustedResult?.metadata?.keywords?.length;

      let textExtractedMetadata: ExtractedPdfMetadata = {};
      if (needsFallbackTextMetadataScan) {
        const frontPageTexts = pages
          .slice(0, 3)
          .map((p) => p.textContent)
          .filter((t) => Boolean(t && t.trim()));
        const strippedFrontMatter =
          frontPageTexts.length >= 2
            ? LayoutExtractor.stripRunningHeadersAndFootersFromText(
                frontPageTexts,
              )
            : {
                cleanedText: combinedText.slice(0, PdfProvider.TEXT_SCAN_LIMIT),
                signatures: new Set<string>(),
              };

        const textForMetadataScan =
          frontPageTexts.length >= 2
            ? [
                strippedFrontMatter.cleanedText,
                ...pages.slice(3, 10).map((p) => p.textContent),
              ]
                .join('\n')
                .slice(0, PdfProvider.TEXT_SCAN_LIMIT)
            : combinedText.slice(0, PdfProvider.TEXT_SCAN_LIMIT);

        textExtractedMetadata = textForMetadataScan
          ? this.extractMetadataFromText(textForMetadataScan)
          : {};
      }

      const tMeta = trustedResult?.metadata;
      const pick = <K extends keyof ExtractedPdfMetadata>(
        field: K,
      ): ExtractedPdfMetadata[K] =>
        (tMeta?.[field] ||
          textExtractedMetadata[field] ||
          unpdfExtractedMetadata[field] ||
          headerExtractedMetadata[field]) as ExtractedPdfMetadata[K];

      const validTitle = (cand?: string, minLen = 0): string | undefined =>
        cand &&
        cand.length > minLen &&
        !cand.toLowerCase().endsWith('.pdf') &&
        !PdfMetadataExtractor.isBogusTitle(cand)
          ? cand
          : undefined;

      const metadata: ExtractedPdfMetadata = {
        doi: pick('doi'),
        isbn: pick('isbn'),
        issn: pick('issn'),
        pmid: pick('pmid'),
        publisher: pick('publisher'),
        place: pick('place'),
        journal: pick('journal'),
        bookTitle: pick('bookTitle'),
        conferenceName: pick('conferenceName'),
        volume: pick('volume'),
        issue: pick('issue'),
        pages: pick('pages'),
        numberOfPages: unpdfExtractedMetadata.numberOfPages,
        arxivId: pick('arxivId'),
        primaryCategory: pick('primaryCategory'),
        title:
          validTitle(tMeta?.title) ||
          validTitle(unpdfExtractedMetadata.title, 8) ||
          validTitle(textExtractedMetadata.title) ||
          validTitle(headerExtractedMetadata.title),
        authors:
          tMeta?.authors && tMeta.authors.length > 0
            ? tMeta.authors
            : textExtractedMetadata.authors &&
                textExtractedMetadata.authors.length > 0
              ? textExtractedMetadata.authors
              : unpdfExtractedMetadata.authors &&
                  unpdfExtractedMetadata.authors.length > 0
                ? unpdfExtractedMetadata.authors
                : headerExtractedMetadata.authors,
        creators: tMeta?.creators
          ? (
              tMeta.creators as Array<{
                orderIndex?: number;
                creatorType?: string;
                fullName?: string;
                firstName?: string;
                lastName?: string;
              }>
            ).map((c, idx: number) => ({
              orderIndex: c.orderIndex ?? idx,
              creatorType: c.creatorType || 'author',
              fullName:
                c.fullName ||
                `${c.firstName || ''} ${c.lastName || ''}`.trim() ||
                'Unknown Author',
              firstName: c.firstName || undefined,
              lastName: c.lastName || undefined,
            }))
          : tMeta?.authors && tMeta.authors.length > 0
            ? tMeta.authors.map((a: string, idx: number) => ({
                orderIndex: idx,
                creatorType: 'author',
                fullName: a,
              }))
            : undefined,
        year: pick('year'),
        publicationDate: pick('publicationDate'),
        abstract:
          tMeta?.abstract ||
          cleanAbstractText(headerExtractedMetadata.abstract) ||
          cleanAbstractText(textExtractedMetadata.abstract) ||
          undefined,
        keywords:
          tMeta?.keywords ||
          (textExtractedMetadata.keywords?.length
            ? textExtractedMetadata.keywords
            : unpdfExtractedMetadata.keywords?.length
              ? unpdfExtractedMetadata.keywords
              : headerExtractedMetadata.keywords),
        rawText: combinedText.slice(0, PdfProvider.TEXT_SCAN_LIMIT),
        isSelfSufficient: trustedResult?.isSelfSufficient,
        qualityScore: trustedResult?.quality?.totalScore,
        engineUsed: trustedResult?.provenance?.engineUsed,
      };

      const trustedProvObj = trustedResult?.provenance as
        | {
            fieldProvenance?: Record<
              string,
              { source: string; confidence: number; extractedAt?: string }
            >;
            rawMatches?: {
              fieldProvenance?: Record<
                string,
                { source: string; confidence: number; extractedAt?: string }
              >;
            };
          }
        | undefined;
      const mergedFieldProvenance: Record<
        string,
        { source: string; confidence: number; extractedAt?: string }
      > = {
        ...(trustedProvObj?.fieldProvenance ??
          trustedProvObj?.rawMatches?.fieldProvenance ??
          {}),
      };
      const nowIso = new Date().toISOString();
      for (const key of Object.keys(metadata) as Array<
        keyof ExtractedPdfMetadata
      >) {
        if (
          key === 'rawText' ||
          key === 'isSelfSufficient' ||
          key === 'qualityScore' ||
          key === 'engineUsed' ||
          key === 'numberOfPages' ||
          metadata[key] === undefined
        ) {
          continue;
        }
        if (mergedFieldProvenance[key]) continue;
        if (trustedResult?.metadata?.[key] !== undefined) {
          mergedFieldProvenance[key] = {
            source: trustedResult.provenance?.engineUsed || 'REGEX',
            confidence: 0.85,
            extractedAt: nowIso,
          };
        } else if (
          (unpdfExtractedMetadata as Record<string, unknown>)[key] !==
            undefined ||
          (headerExtractedMetadata as Record<string, unknown>)[key] !==
            undefined
        ) {
          mergedFieldProvenance[key] = {
            source: 'XMP',
            confidence: 0.9,
            extractedAt: nowIso,
          };
        } else if (
          (textExtractedMetadata as Record<string, unknown>)[key] !== undefined
        ) {
          mergedFieldProvenance[key] = {
            source: 'REGEX',
            confidence: 0.85,
            extractedAt: nowIso,
          };
        }
      }
      if (metadata.creators && !mergedFieldProvenance.creators) {
        mergedFieldProvenance.creators = mergedFieldProvenance.authors || {
          source: trustedResult?.provenance?.engineUsed || 'REGEX',
          confidence: 0.85,
          extractedAt: nowIso,
        };
      }
      (
        metadata as ExtractedPdfMetadata & {
          fieldProvenance?: Record<
            string,
            { source: string; confidence: number; extractedAt?: string }
          >;
        }
      ).fieldProvenance = mergedFieldProvenance;

      const extractedReferences =
        !options?.headerOnly && combinedText
          ? this.textMetadataExtractor.extractBibliographyReferences(
              combinedText,
            )
          : [];
      if (extractedReferences.length > 0) {
        metadata.referenceCount = extractedReferences.length;
      }

      return {
        metadata,
        pages,
        ...(extractedReferences.length > 0
          ? { references: extractedReferences }
          : {}),
        ...(extractedSections.length > 0
          ? { sections: extractedSections }
          : {}),
      };
    } finally {
      const disposeProxy = async (
        proxy?: Awaited<ReturnType<typeof getDocumentProxy>>,
      ) => {
        if (!proxy) return;
        const disposable = proxy as {
          cleanup?: () => Promise<void> | void;
          destroy?: () => Promise<void> | void;
        };
        await Promise.resolve(disposable.cleanup?.()).catch(() => {});
        await Promise.resolve(disposable.destroy?.()).catch(() => {});
      };
      await disposeProxy(fallbackDocumentProxy);
      await disposeProxy(sharedDocumentProxy);
    }
  }

  private async extractOutlineSections(
    document: Awaited<ReturnType<typeof getDocumentProxy>>,
    pages: Array<{
      pageIndex: number;
      pageNumber?: number;
      textContent: string;
    }>,
  ): Promise<DocumentSection[]> {
    return extractPdfOutlineSections(document, pages);
  }

  async extractMetadataFromBufferAsync(
    buffer: Buffer,
  ): Promise<ExtractedPdfMetadata> {
    return this.textMetadataExtractor.extractMetadataFromBufferAsync(buffer);
  }

  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata {
    return this.textMetadataExtractor.extractMetadataFromBuffer(buffer);
  }

  extractFromText(text: string): string | null {
    return this.textMetadataExtractor.extractFromText(text);
  }

  extractMetadataFromText(text: string): ExtractedPdfMetadata {
    return this.textMetadataExtractor.extractMetadataFromText(text);
  }
}
