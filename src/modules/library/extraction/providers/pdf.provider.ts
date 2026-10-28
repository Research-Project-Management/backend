import { Injectable, Logger, Optional } from '@nestjs/common';
import { getDocumentProxy, getMeta } from 'unpdf';
import { AcademicCreator } from '@/modules/library/core/types/bibliographic.types';
import {
  cleanAbstractText,
  libraryConfig,
  ExtractedPdfMetadata,
  OcrPageProvenance,
  OcrProvenanceData,
  ExtractedPdfDocument,
  TrustedExtractionResult,
} from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';
import { OcrProvider } from './ocr.provider';
import {
  OcrPageResult,
  OcrBlock,
} from '@/modules/library/extraction/types/ocr.types';
import { TrustedExtractionService } from '@/modules/library/extraction/services/trusted-extraction.service';
import { PdfTextMetadataExtractor } from './pdf-text-metadata.extractor';

export type {
  ExtractedPdfMetadata,
  OcrPageProvenance,
  OcrProvenanceData,
  ExtractedPdfDocument,
};

@Injectable()
export class PdfProvider {
  private readonly logger = new Logger(PdfProvider.name);
  public static readonly TEXT_SCAN_LIMIT = 50_000;

  constructor(
    @Optional() private readonly ocrProvider?: OcrProvider,
    @Optional() private readonly trustedExtractor?: TrustedExtractionService,
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
      textContent: string;
      charOffset: number;
    }> = [];

    const ocrPageResults: OcrPageResult[] = [];
    const imageDimensionsMap = new Map<
      number,
      { width: number; height: number }
    >();

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
      | Awaited<ReturnType<typeof getDocumentProxy>>
      | undefined;

    try {
      // 2. Local-first In-Process Fast-Path: TrustedExtractionFacade (< 15ms)
      let trustedResult: TrustedExtractionResult | undefined;
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

      // 3. Extract metadata from buffer using pdf-lib + safe decoded fallback
      const headerExtractedMetadata =
        await this.extractMetadataFromBufferAsync(buffer);

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
              const rawTokens = informationRecord.Keywords.split(/[,;•|]/)
                .map((k: string) => k.trim())
                .filter(
                  (k: string) => k.length > 1 && k.split(/\s+/).length <= 7,
                );
              const keywordList = normalizeAcademicTags(rawTokens);
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

        let currentOffset = 0;

        for (let pageIndex = 1; pageIndex <= maxPagesToExtract; pageIndex++) {
          const page = await document.getPage(pageIndex);
          try {
            const content = (await page.getTextContent()) as {
              items: Array<{ str?: string; hasEOL?: boolean }>;
            };
            let pageText = content.items
              .map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' '))
              .join('');

            const scanDetection = this.ocrProvider?.detectScannedPage
              ? await this.ocrProvider.detectScannedPage(
                  page as unknown as Parameters<
                    NonNullable<typeof this.ocrProvider>['detectScannedPage']
                  >[0],
                  content,
                )
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
                const rawOcrText =
                  typeof res === 'string'
                    ? res
                    : typeof (res as { text?: string })?.text === 'string'
                      ? (res as { text?: string }).text
                      : '';
                if (scanDetection.isHybrid) {
                  if (rawOcrText && rawOcrText.length > pageText.length) {
                    pageText = rawOcrText;
                  }
                } else if (rawOcrText) {
                  pageText = rawOcrText;
                }
                if (typeof res === 'object' && res !== null && (res as { wasOcr?: boolean }).wasOcr) {
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
          } finally {
            try {
              page?.cleanup?.();
            } catch {
              // Ignore page cleanup errors
            }
          }
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
      issn:
        trustedResult?.metadata?.issn ||
        textExtractedMetadata.issn ||
        unpdfExtractedMetadata.issn ||
        headerExtractedMetadata.issn,
      pmid:
        trustedResult?.metadata?.pmid ||
        textExtractedMetadata.pmid ||
        unpdfExtractedMetadata.pmid ||
        headerExtractedMetadata.pmid,
      publisher:
        trustedResult?.metadata?.publisher ||
        textExtractedMetadata.publisher ||
        unpdfExtractedMetadata.publisher ||
        headerExtractedMetadata.publisher,
      place:
        trustedResult?.metadata?.place ||
        textExtractedMetadata.place ||
        unpdfExtractedMetadata.place ||
        headerExtractedMetadata.place,
      journal:
        trustedResult?.metadata?.journal ||
        textExtractedMetadata.journal ||
        unpdfExtractedMetadata.journal ||
        headerExtractedMetadata.journal,
      bookTitle:
        trustedResult?.metadata?.bookTitle ||
        textExtractedMetadata.bookTitle ||
        unpdfExtractedMetadata.bookTitle ||
        headerExtractedMetadata.bookTitle,
      conferenceName:
        trustedResult?.metadata?.conferenceName ||
        textExtractedMetadata.conferenceName ||
        unpdfExtractedMetadata.conferenceName ||
        headerExtractedMetadata.conferenceName,
      volume:
        trustedResult?.metadata?.volume ||
        textExtractedMetadata.volume ||
        unpdfExtractedMetadata.volume ||
        headerExtractedMetadata.volume,
      issue:
        trustedResult?.metadata?.issue ||
        textExtractedMetadata.issue ||
        unpdfExtractedMetadata.issue ||
        headerExtractedMetadata.issue,
      pages:
        trustedResult?.metadata?.pages ||
        textExtractedMetadata.pages ||
        unpdfExtractedMetadata.pages ||
        headerExtractedMetadata.pages,
      numberOfPages: unpdfExtractedMetadata.numberOfPages,
      arxivId:
        trustedResult?.metadata?.arxivId ||
        textExtractedMetadata.arxivId ||
        unpdfExtractedMetadata.arxivId ||
        headerExtractedMetadata.arxivId,
      primaryCategory:
        trustedResult?.metadata?.primaryCategory ||
        textExtractedMetadata.primaryCategory ||
        unpdfExtractedMetadata.primaryCategory ||
        headerExtractedMetadata.primaryCategory,
      title:
        (trustedResult?.metadata?.title &&
        !TrustedExtractionService.isBogusTitle(trustedResult.metadata.title)
          ? trustedResult.metadata.title
          : undefined) ||
        (unpdfExtractedMetadata.title &&
        unpdfExtractedMetadata.title.length > 8 &&
        !TrustedExtractionService.isBogusTitle(unpdfExtractedMetadata.title)
          ? unpdfExtractedMetadata.title
          : undefined) ||
        (textExtractedMetadata.title &&
        !TrustedExtractionService.isBogusTitle(textExtractedMetadata.title)
          ? textExtractedMetadata.title
          : undefined) ||
        (headerExtractedMetadata.title &&
        !headerExtractedMetadata.title.toLowerCase().endsWith('.pdf') &&
        !TrustedExtractionService.isBogusTitle(headerExtractedMetadata.title)
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
      creators: trustedResult?.metadata?.creators
        ? (
            trustedResult.metadata.creators as Array<{
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
        : trustedResult?.metadata?.authors &&
            trustedResult.metadata.authors.length > 0
          ? trustedResult.metadata.authors.map((a: string, idx: number) => ({
              orderIndex: idx,
              creatorType: 'author',
              fullName: a,
            }))
          : undefined,
      year:
        trustedResult?.metadata?.year ||
        textExtractedMetadata.year ||
        unpdfExtractedMetadata.year ||
        headerExtractedMetadata.year,
      publicationDate:
        trustedResult?.metadata?.publicationDate ||
        textExtractedMetadata.publicationDate ||
        unpdfExtractedMetadata.publicationDate ||
        headerExtractedMetadata.publicationDate,
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
    for (const key of Object.keys(metadata) as Array<keyof ExtractedPdfMetadata>) {
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
          source: trustedResult.provenance?.engineUsed || 'ACADEMIC_REGEX',
          confidence: 0.85,
          extractedAt: nowIso,
        };
      } else if (
        (unpdfExtractedMetadata as Record<string, unknown>)[key] !== undefined ||
        (headerExtractedMetadata as Record<string, unknown>)[key] !== undefined
      ) {
        mergedFieldProvenance[key] = {
          source: 'XMP_BINARY',
          confidence: 0.9,
          extractedAt: nowIso,
        };
      } else if (
        (textExtractedMetadata as Record<string, unknown>)[key] !== undefined
      ) {
        mergedFieldProvenance[key] = {
          source: 'ACADEMIC_REGEX',
          confidence: 0.85,
          extractedAt: nowIso,
        };
      }
    }
    if (metadata.creators && !mergedFieldProvenance.creators) {
      mergedFieldProvenance.creators = mergedFieldProvenance.authors || {
        source: trustedResult?.provenance?.engineUsed || 'ACADEMIC_REGEX',
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

    let searchablePdfBuffer: Buffer | undefined;

    if (ocrPageResults.length > 0 && this.ocrProvider?.generateSearchablePdf) {
      try {
        searchablePdfBuffer = await this.ocrProvider.generateSearchablePdf(
          buffer,
          ocrPageResults,
          imageDimensionsMap,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to generate sandwich PDF: ${message}`);
      }
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
            (acc: number, b: OcrBlock) => acc + (b.lines?.length || 0),
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
        ocrProvenance,
        searchablePdfBuffer,
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
