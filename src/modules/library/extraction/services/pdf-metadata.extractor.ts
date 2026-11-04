import { Injectable, Logger } from '@nestjs/common';
import {
  IPdfMetadataExtractorPort,
  PdfMetadataExtractionResult,
} from '@/modules/library/core/types/extraction.types';
import { ItemMetadata } from '@/modules/library/core';
import { XmpParser } from '@/modules/library/extraction/providers/pdf-outline.extractor';
import { RegexExtractor } from '@/modules/library/core/domain/regex.extractor';
import { LayoutExtractor } from '@/modules/library/extraction/extractors/layout.extractor';
import { PdfTextMetadataExtractor } from '@/modules/library/extraction/providers/pdf-text-metadata.extractor';
import {
  FieldExtractionProvenance,
  IPdfExtractionTier,
  MetadataQualityGate,
  PdfExtractionTierContext,
  runPdfExtractionTierChain,
} from '@/modules/library/extraction/domain/attachments.domain';
import { extractText, getDocumentProxy } from 'unpdf';
import {
  cleanAuthorName,
  normalizeTitleCase,
  isPlausibleAuthorName,
  splitConcatenatedAuthors,
  yearFromArxivId,
  repairFragmentedTitle,
} from '@/modules/library/core';

export { PdfExtractionTierContext, runPdfExtractionTierChain };
export type { IPdfExtractionTier };

export class XmpExtractionTier implements IPdfExtractionTier {
  readonly tierName = 'XMP';
  constructor(
    private readonly run: (
      ctx: PdfExtractionTierContext,
    ) => Promise<void> | void,
  ) {}
  async executeTier(ctx: PdfExtractionTierContext): Promise<void> {
    await this.run(ctx);
  }
}

export class RegexExtractionTier implements IPdfExtractionTier {
  readonly tierName = 'REGEX';
  constructor(
    private readonly run: (
      ctx: PdfExtractionTierContext,
    ) => Promise<void> | void,
  ) {}
  async executeTier(ctx: PdfExtractionTierContext): Promise<void> {
    await this.run(ctx);
  }
}

export class LayoutExtractionTier implements IPdfExtractionTier {
  readonly tierName = 'LAYOUT';
  constructor(
    private readonly run: (
      ctx: PdfExtractionTierContext,
    ) => Promise<void> | void,
  ) {}
  async executeTier(ctx: PdfExtractionTierContext): Promise<void> {
    await this.run(ctx);
  }
}

/**
 * Local-first deterministic PDF metadata extractor (Zotero recognizePDF.js parity).
 *
 * Implements the 3-Tier Zero-Network Deterministic Cascade via `PdfExtractionTierContext`:
 *   Tier 1: XmpParser (< 0.5ms) - Reads ISO 16684 binary XML streams.
 *   Tier 2: RegexExtractor (< 5ms) - Scans ISO 26324 DOI, arXiv, PMID, ISBN, and publisher stamps.
 *   Tier 3: LayoutExtractor (< 25ms) - Reads PDF.js text layer (including pre-OCR'd Sandwich PDF
 *           invisible text layers) to extract front-matter Title and Authors.
 */
@Injectable()
export class PdfMetadataExtractor implements IPdfMetadataExtractorPort {
  private readonly logger = new Logger(PdfMetadataExtractor.name);
  private readonly infoDictExtractor = new PdfTextMetadataExtractor();

  public static isBogusTitle(t?: string): boolean {
    if (!t) return true;
    const lower = t.toLowerCase().trim();
    return (
      lower.startsWith('microsoft') ||
      lower.startsWith('untitled') ||
      lower.startsWith('document') ||
      lower.startsWith('arxiv:') ||
      lower === 'technical report' ||
      /^arxiv\s*:\s*[a-z0-9\-./]+/i.test(lower) ||
      /\.(docx?|pdf|tex|txt|ps|eps|dvi|ppt|pptx|rtf|html?)$/i.test(lower) ||
      /^[a-z0-9_.-]+\s+\d+\.\.\d+$/i.test(lower) ||
      lower.length < 5
    );
  }

  public buildExtractionTiers(
    buffer: Buffer,
    pdfDocument?: Awaited<ReturnType<typeof getDocumentProxy>>,
  ): readonly IPdfExtractionTier[] {
    return [
      new XmpExtractionTier(async (ctx) => {
        await this.executeXmpTier(ctx, buffer);
      }),
      new RegexExtractionTier(async (ctx) => {
        await this.extractFrontMatterText(ctx, buffer);
        this.executeRegexTier(ctx);
      }),
      new LayoutExtractionTier(async (ctx) => {
        await this.executeLayoutTier(ctx, buffer, pdfDocument);
      }),
    ];
  }

  /**
   * Executes the autonomous multi-tier extraction pipeline.
   */
  async extract(
    buffer: Buffer,
    preferredFilename?: string,
    pdfDocument?: Awaited<ReturnType<typeof getDocumentProxy>>,
  ): Promise<PdfMetadataExtractionResult> {
    const startedAt = Date.now();
    const ctx = new PdfExtractionTierContext({
      buffer,
      sharedDoc: pdfDocument,
    });

    const tiers = this.buildExtractionTiers(buffer, pdfDocument);
    try {
      await runPdfExtractionTierChain(ctx, tiers);

      // Accuracy refinement (year, author list, fragmented title, arXiv DOI)
      this.refineMetadata(
        ctx.merged,
        ctx.xmpYear,
        ctx.pageText,
        ctx.rawMatches,
      );
    } finally {
      if (ctx.sharedDoc && ctx.sharedDoc !== pdfDocument) {
        try {
          await (
            ctx.sharedDoc as { destroy?: () => Promise<void> | void }
          ).destroy?.();
        } catch {
          // Ignore PDF.js cleanup errors
        }
      }
    }
    const gateEvaluation = MetadataQualityGate.evaluate(ctx.merged);

    // Filename fallback ONLY if title is still missing AND no authoritative identifier exists.
    const hasAuthoritativeId = Boolean(
      ctx.merged.doi ||
      ctx.merged.arxivId ||
      ctx.merged.pmid ||
      ctx.merged.isbn,
    );
    if (!ctx.merged.title && !hasAuthoritativeId && preferredFilename) {
      const cleanSlug = preferredFilename
        .replace(/\.[a-zA-Z0-9]+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (cleanSlug.length > 3) {
        ctx.mergeFieldIfEmpty(
          'title',
          normalizeTitleCase(cleanSlug),
          'FILENAME_FALLBACK',
          0.3,
        );
        ctx.rawMatches.titleFromFilename = true;
      }
    }

    if (!ctx.merged.title) {
      ctx.merged.title = 'Uploaded Document';
      ctx.rawMatches.titleFromFilename = true;
    }

    const durationMs = Date.now() - startedAt;

    this.logger.debug(
      `Trusted extraction completed in ${durationMs}ms [${ctx.engineUsed}] | Score: ${gateEvaluation.breakdown.totalScore} | Sufficient: ${gateEvaluation.isSelfSufficient} | Title: "${ctx.merged.title}" | DOI: ${ctx.merged.doi || 'none'}`,
    );

    ctx.rawMatches.fieldProvenance = { ...ctx.provenance };
    (
      ctx.merged as ItemMetadata & {
        fieldProvenance?: Record<string, FieldExtractionProvenance>;
      }
    ).fieldProvenance = { ...ctx.provenance };

    return {
      metadata: ctx.merged,
      quality: gateEvaluation.breakdown,
      isSelfSufficient: gateEvaluation.isSelfSufficient,
      missingFields: gateEvaluation.missingFields,
      provenance: {
        extractedAt: new Date().toISOString(),
        engineUsed: ctx.engineUsed,
        executionTimeMs: durationMs,
        qualityBreakdown: gateEvaluation.breakdown,
        rawMatches: ctx.rawMatches,
        fieldProvenance: { ...ctx.provenance },
      },
    };
  }

  private async executeXmpTier(
    ctx: PdfExtractionTierContext,
    buffer: Buffer,
  ): Promise<void> {
    const xmp = XmpParser.parse(buffer);
    if (xmp) {
      ctx.xmpFound = true;
      ctx.xmpYear = xmp.year;
      ctx.rawMatches.xmpFound = true;
      if (xmp.doi) {
        ctx.rawMatches.detectedDoi = xmp.doi;
      }

      const cleanTitle =
        xmp.title && !PdfMetadataExtractor.isBogusTitle(xmp.title)
          ? normalizeTitleCase(
              xmp.title.replace(/^lncs\s+\d+\s*[-–—:]\s*/i, ''),
            )
          : undefined;
      const cleanAuthors =
        xmp.authors && xmp.authors.length > 0
          ? xmp.authors.map((a) => cleanAuthorName(a)).filter(Boolean)
          : undefined;

      ctx.mergeTierFields(
        {
          doi: xmp.doi,
          title: cleanTitle,
          authors: cleanAuthors,
          year: xmp.year,
          publicationDate: xmp.publicationDate,
          journal: xmp.journal,
          publisher: xmp.publisher,
          volume: xmp.volume,
          issue: xmp.issue,
          pages: xmp.pages,
          issn: xmp.issn,
          isbn: xmp.isbn,
          abstract: xmp.description,
          keywords: xmp.keywords,
        },
        'XMP',
        0.95,
        { isBogusTitle: PdfMetadataExtractor.isBogusTitle },
      );
      ctx.engineUsed = 'XMP';
    }

    // Also inspect PDF /Info dictionary via pdf-lib & raw literal string fallback
    // when XMP is absent or missing title/authors/keywords/year
    if (
      !ctx.merged.title ||
      !ctx.merged.authors?.length ||
      !ctx.merged.doi ||
      !ctx.merged.year
    ) {
      try {
        const infoMeta =
          await this.infoDictExtractor.extractMetadataFromBufferAsync(buffer);
        const infoTitle =
          infoMeta.title && !PdfMetadataExtractor.isBogusTitle(infoMeta.title)
            ? normalizeTitleCase(infoMeta.title)
            : undefined;
        const didMergeInfo = ctx.mergeTierFields(
          {
            doi: infoMeta.doi,
            arxivId: infoMeta.arxivId,
            title: infoTitle,
            authors: infoMeta.authors,
            year: infoMeta.year,
            abstract: infoMeta.abstract,
            keywords: infoMeta.keywords,
          },
          'XMP',
          0.9,
          { isBogusTitle: PdfMetadataExtractor.isBogusTitle },
        );
        if (didMergeInfo && !ctx.xmpFound) {
          ctx.xmpFound = true;
          ctx.engineUsed = 'XMP';
        }
      } catch {
        // Ignore PDF /Info dictionary parse errors
      }
    }
  }

  private async extractFrontMatterText(
    ctx: PdfExtractionTierContext,
    buffer: Buffer,
  ): Promise<void> {
    try {
      let docText = '';
      try {
        let doc = ctx.sharedDoc;
        if (!doc) {
          const cloned = new Uint8Array(buffer.byteLength);
          cloned.set(buffer);
          doc = await getDocumentProxy(cloned);
          ctx.sharedDoc = doc;
        }
        if (doc && doc.numPages > 0) {
          const pagesToRead = Math.min(doc.numPages, 3);
          const pageChunks: string[] = [];
          const readPageText = async (pageNum: number): Promise<string> => {
            const page = await doc.getPage(pageNum);
            try {
              const content = await page.getTextContent();
              if (content?.items && content.items.length > 0) {
                const items = content.items as Array<{
                  str?: string;
                  hasEOL?: boolean;
                }>;
                return items
                  .filter((it) => it && it.str != null)
                  .map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' '))
                  .join('')
                  .trim();
              }
              return '';
            } finally {
              try {
                page?.cleanup?.();
              } catch {
                // Ignore page cleanup errors
              }
            }
          };

          for (let i = 1; i <= pagesToRead; i++) {
            const pText = await readPageText(i);
            if (pText.length > 0) {
              pageChunks.push(pText);
            }
          }
          if (pageChunks.length > 0) {
            ctx.pageTexts = pageChunks;
            const stripped =
              LayoutExtractor.stripRunningHeadersAndFootersFromText(
                pageChunks,
              );
            ctx.runningHeaderFooters = stripped.signatures;
            docText = stripped.cleanedText;
          }
        }
      } catch {
        // Fall back to extractText below
      }

      if (docText && docText.trim().length > 0) {
        ctx.pageText = docText;
      } else if (!ctx.sharedDoc) {
        const cloned = new Uint8Array(buffer.byteLength);
        cloned.set(buffer);
        const rawResult = await extractText(cloned, { mergePages: false });
        const pages = Array.isArray(rawResult)
          ? rawResult
          : typeof rawResult === 'object' &&
              rawResult !== null &&
              'totalPages' in rawResult &&
              Array.isArray(rawResult.totalPages)
            ? rawResult.totalPages
            : [
                typeof rawResult === 'string'
                  ? rawResult
                  : typeof rawResult === 'object' &&
                      rawResult !== null &&
                      'text' in rawResult &&
                      typeof rawResult.text === 'string'
                    ? rawResult.text
                    : '',
              ];
        const firstThree = pages.slice(0, 3);
        ctx.pageTexts = firstThree;
        const stripped =
          LayoutExtractor.stripRunningHeadersAndFootersFromText(
            firstThree,
          );
        ctx.runningHeaderFooters = stripped.signatures;
        ctx.pageText = stripped.cleanedText;
      }
    } catch {
      // unpdf text extraction failure is non-fatal if XMP succeeded
    }
  }

  private executeRegexTier(ctx: PdfExtractionTierContext): void {
    if (!ctx.pageText || ctx.pageText.trim().length === 0) return;

    const regexResults = RegexExtractor.scan(ctx.pageText);

    if (ctx.mergeFieldIfEmpty('doi', regexResults.doi, 'REGEX', 0.9)) {
      ctx.rawMatches.detectedDoi = regexResults.doi;
    }
    if (regexResults.arxivId) {
      ctx.merged.arxivId = regexResults.arxivId;
      ctx.provenance.arxivId = { source: 'REGEX', confidence: 0.9 };
      ctx.rawMatches.detectedArxivId = regexResults.arxivId;
      ctx.mergeFieldIfEmpty(
        'doi',
        `10.48550/arXiv.${regexResults.arxivId}`,
        'REGEX',
        0.85,
      );
    }
    if (
      ctx.mergeFieldIfEmpty('pmid', regexResults.pmid, 'REGEX', 0.9)
    ) {
      ctx.rawMatches.detectedPmid = regexResults.pmid;
    }

    ctx.mergeTierFields(
      {
        isbn: regexResults.isbn,
        issn: regexResults.issn,
        year: regexResults.year,
        journal: regexResults.journal,
        publisher: regexResults.publisher,
        volume: regexResults.volume,
        issue: regexResults.issue,
        pages: regexResults.pages,
        title: regexResults.title,
        authors: regexResults.authors,
        abstract: regexResults.abstract,
        keywords: regexResults.keywords,
      },
      'REGEX',
      0.85,
    );

    if (regexResults.matchedSignatures.length > 0) {
      ctx.rawMatches.matchedSignatures =
        regexResults.matchedSignatures.join(', ');
      if (!ctx.xmpFound) ctx.engineUsed = 'REGEX';
    }
  }

  private async executeLayoutTier(
    ctx: PdfExtractionTierContext,
    buffer: Buffer,
    _pdfDocument: Awaited<ReturnType<typeof getDocumentProxy>> | undefined,
  ): Promise<void> {
    try {
      if (
        !ctx.merged.title ||
        PdfMetadataExtractor.isBogusTitle(ctx.merged.title) ||
        !ctx.merged.authors ||
        ctx.merged.authors.length === 0
      ) {
        let layoutResults = await LayoutExtractor.extract(
          buffer,
          ctx.sharedDoc,
          ctx.runningHeaderFooters,
        );

        if (
          !layoutResults.title &&
          !layoutResults.authors?.length &&
          ctx.pageText &&
          ctx.pageText.trim().length > 20
        ) {
          layoutResults = LayoutExtractor.extractFromPlainText(
            ctx.pageText,
          );
        }

        ctx.mergeTierFields(
          {
            title: layoutResults.title,
            authors: layoutResults.authors,
            abstract: layoutResults.abstract,
            year: layoutResults.year,
            doi: layoutResults.doi,
          },
          'LAYOUT',
          0.75,
          { isBogusTitle: PdfMetadataExtractor.isBogusTitle },
        );

        if (layoutResults.doi && !ctx.rawMatches.detectedDoi) {
          ctx.rawMatches.detectedDoi = layoutResults.doi;
        }
        if (layoutResults.maxFontSize) {
          ctx.rawMatches.maxFontSize = layoutResults.maxFontSize;
        }
        if (layoutResults.title || layoutResults.authors?.length) {
          ctx.engineUsed =
            ctx.xmpFound || Boolean(ctx.rawMatches.matchedSignatures)
              ? 'HYBRID'
              : 'LAYOUT';
        }
      }
    } catch {
      // Layout heuristic extraction failure is non-fatal
    }
  }

  /**
   * Post-processing that corrects systematic first-page extraction errors.
   */
  private refineMetadata(
    merged: ItemMetadata,
    xmpYear: number | undefined,
    pageText: string,
    rawMatches: Record<string, unknown>,
  ): void {
    const refinements: string[] = [];

    const arxivStampYearMatch = pageText?.match(
      /arXiv:\s*(?:\d{4}\.\d{4,5}|[a-zA-Z-]+(?:\.[a-zA-Z-]+)?\/\d{7})(?:v\d+)?\s+\[[^\]]+\]\s+\d{1,2}\s+[A-Za-z]+\s+(19\d{2}|20\d{2})/i,
    );
    const arxivStampYear = arxivStampYearMatch
      ? parseInt(arxivStampYearMatch[1], 10)
      : undefined;
    const arxivYear = arxivStampYear ?? yearFromArxivId(merged.arxivId);
    if (arxivYear && !xmpYear && !merged.journal && merged.year !== arxivYear) {
      rawMatches.yearBeforeRefinement = merged.year;
      merged.year = arxivYear;
      refinements.push(
        arxivStampYear ? 'year-from-arxiv-stamp' : 'year-from-arxiv-id',
      );
    } else if (
      merged.year &&
      (merged.year < 1900 || merged.year > new Date().getFullYear() + 1)
    ) {
      delete merged.year;
      refinements.push('year-out-of-range-dropped');
    }

    if (merged.authors && merged.authors.length > 0) {
      const lone = merged.authors.length === 1;
      const expanded = merged.authors.flatMap((a) =>
        splitConcatenatedAuthors(a, lone ? 4 : 6),
      );
      const cleaned = expanded
        .map((a) => cleanAuthorName(a))
        .filter((a) => a && isPlausibleAuthorName(a));
      if (
        cleaned.length !== merged.authors.length ||
        cleaned.some((a, i) => a !== merged.authors![i])
      ) {
        rawMatches.authorsBeforeRefinement = merged.authors.length;
        merged.authors = cleaned;
        refinements.push('authors-normalized');
      }
    }

    if (merged.title) {
      const repaired = repairFragmentedTitle(merged.title, pageText);
      if (repaired) {
        rawMatches.titleBeforeRefinement = merged.title;
        merged.title = normalizeTitleCase(repaired);
        refinements.push('title-repaired');
      }
    }

    if (refinements.length > 0) rawMatches.refinements = refinements;
  }
}
