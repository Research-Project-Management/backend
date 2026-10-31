import { Injectable, Logger } from '@nestjs/common';
import {
  ITrustedExtractorPort,
  TrustedExtractionResult,
} from '@/modules/library/extraction/types/trusted-extraction.types';
import { ItemMetadata } from '@/modules/library/core';
import { XmpParser } from '@/modules/library/extraction/extractors/xmp.parser';
import { AcademicRegexCatalog } from '@/modules/library/core/domain/academic-regex.catalog';
import { LayoutHeuristicExtractor } from '@/modules/library/extraction/extractors/layout-heuristic.extractor';
import { MeXtractExtractor } from '@/modules/library/extraction/extractors/mextract.extractor';
import { MetadataQualityGate } from '@/modules/library/extraction/extractors/metadata-quality.gate';
import {
  FieldExtractionProvenance,
  IPdfExtractionTier,
  PdfExtractionTierContext,
  runPdfExtractionTierChain,
} from '@/modules/library/extraction/domain/pdf-extraction-tier.chain';
import { extractText, getDocumentProxy } from 'unpdf';
import {
  cleanAuthorName,
  normalizeAcademicTitleCase,
  isPlausibleAuthorName,
  splitConcatenatedAuthors,
  yearFromArxivId,
  repairFragmentedTitle,
} from '@/modules/library/core';

export { PdfExtractionTierContext, runPdfExtractionTierChain };
export type { IPdfExtractionTier };

export class XmpExtractionTier implements IPdfExtractionTier {
  readonly tierName = 'XMP_BINARY';
  constructor(
    private readonly run: (
      ctx: PdfExtractionTierContext,
    ) => Promise<void> | void,
  ) {}
  async executeTier(ctx: PdfExtractionTierContext): Promise<void> {
    await this.run(ctx);
  }
}

export class AcademicRegexExtractionTier implements IPdfExtractionTier {
  readonly tierName = 'ACADEMIC_REGEX';
  constructor(
    private readonly run: (
      ctx: PdfExtractionTierContext,
    ) => Promise<void> | void,
  ) {}
  async executeTier(ctx: PdfExtractionTierContext): Promise<void> {
    await this.run(ctx);
  }
}

export class LayoutHeuristicExtractionTier implements IPdfExtractionTier {
  readonly tierName = 'LAYOUT_HEURISTIC';
  constructor(
    private readonly run: (
      ctx: PdfExtractionTierContext,
    ) => Promise<void> | void,
  ) {}
  async executeTier(ctx: PdfExtractionTierContext): Promise<void> {
    await this.run(ctx);
  }
}

export class MeXtractTier implements IPdfExtractionTier {
  readonly tierName = 'MEXTRACT_SLM';
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
 * Master Service orchestrating local-first trusted academic metadata extraction.
 *
 * Implements the 4-Tier Zero-Network Cascade via `PdfExtractionTierContext`:
 *   Tier 1: XmpParser (< 0.5ms) - Reads ISO 16684 binary XML streams.
 *   Tier 2: AcademicRegexCatalog (< 5ms) - Scans ISO 26324 DOI, arXiv, and publisher stamps.
 *   Tier 3: LayoutHeuristicExtractor (< 25ms) - Visual font-size clustering for non-DOI papers.
 *   Tier 4: MeXtractExtractor (< 50ms) - Small Language Model (SLM / Qwen2.5-0.5B-Instruct ONNX)
 *           for complex/unstructured headers, preprints, and non-standard layouts.
 */
@Injectable()
export class TrustedExtractionService implements ITrustedExtractorPort {
  private readonly logger = new Logger(TrustedExtractionService.name);

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
      new XmpExtractionTier((ctx) => {
        this.executeXmpTier(ctx, buffer);
      }),
      new AcademicRegexExtractionTier(async (ctx) => {
        await this.extractFrontMatterText(ctx, buffer);
        this.executeAcademicRegexTier(ctx);
      }),
      new LayoutHeuristicExtractionTier(async (ctx) => {
        const gateEvaluation = MetadataQualityGate.evaluate(ctx.merged);
        await this.executeLayoutHeuristicTier(
          ctx,
          buffer,
          pdfDocument,
          gateEvaluation.isSelfSufficient,
        );
      }),
      new MeXtractTier(async (ctx) => {
        const gateEvaluation = MetadataQualityGate.evaluate(ctx.merged);
        if (
          !gateEvaluation.isSelfSufficient &&
          ctx.pageText &&
          ctx.pageText.trim().length > 30
        ) {
          await this.executeMeXtractTier(ctx);
        }
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
  ): Promise<TrustedExtractionResult> {
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
          normalizeAcademicTitleCase(cleanSlug),
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

  private executeXmpTier(ctx: PdfExtractionTierContext, buffer: Buffer): void {
    const xmp = XmpParser.parse(buffer);
    if (!xmp) return;

    ctx.xmpFound = true;
    ctx.xmpYear = xmp.year;
    ctx.rawMatches.xmpFound = true;
    if (xmp.doi) {
      ctx.rawMatches.detectedDoi = xmp.doi;
    }

    const cleanTitle =
      xmp.title && !TrustedExtractionService.isBogusTitle(xmp.title)
        ? normalizeAcademicTitleCase(
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
      'XMP_BINARY',
      0.95,
      { isBogusTitle: TrustedExtractionService.isBogusTitle },
    );
    ctx.engineUsed = 'XMP_BINARY';
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
            docText = pageChunks.join('\n\n');
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
        ctx.pageText = pages.slice(0, 3).join('\n\n');
      }
    } catch {
      // unpdf text extraction failure is non-fatal if XMP succeeded
    }
  }

  private executeAcademicRegexTier(ctx: PdfExtractionTierContext): void {
    if (!ctx.pageText || ctx.pageText.trim().length === 0) return;

    const regexResults = AcademicRegexCatalog.scan(ctx.pageText);

    if (ctx.mergeFieldIfEmpty('doi', regexResults.doi, 'ACADEMIC_REGEX', 0.9)) {
      ctx.rawMatches.detectedDoi = regexResults.doi;
    }
    if (regexResults.arxivId) {
      ctx.merged.arxivId = regexResults.arxivId;
      ctx.provenance.arxivId = { source: 'ACADEMIC_REGEX', confidence: 0.9 };
      ctx.rawMatches.detectedArxivId = regexResults.arxivId;
      ctx.mergeFieldIfEmpty(
        'doi',
        `10.48550/arXiv.${regexResults.arxivId}`,
        'ACADEMIC_REGEX',
        0.85,
      );
    }
    if (
      ctx.mergeFieldIfEmpty('pmid', regexResults.pmid, 'ACADEMIC_REGEX', 0.9)
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
      'ACADEMIC_REGEX',
      0.85,
    );

    if (regexResults.matchedSignatures.length > 0) {
      ctx.rawMatches.matchedSignatures =
        regexResults.matchedSignatures.join(', ');
      if (!ctx.xmpFound) ctx.engineUsed = 'ACADEMIC_REGEX';
    }
  }

  private async executeLayoutHeuristicTier(
    ctx: PdfExtractionTierContext,
    buffer: Buffer,
    pdfDocument: Awaited<ReturnType<typeof getDocumentProxy>> | undefined,
    isSelfSufficient: boolean,
  ): Promise<void> {
    try {
      if (
        !isSelfSufficient &&
        (!ctx.merged.title ||
          TrustedExtractionService.isBogusTitle(ctx.merged.title) ||
          !ctx.merged.authors ||
          ctx.merged.authors.length === 0)
      ) {
        const layoutResults = await LayoutHeuristicExtractor.extract(
          buffer,
          ctx.sharedDoc,
        );

        ctx.mergeTierFields(
          {
            title: layoutResults.title,
            authors: layoutResults.authors,
            abstract: layoutResults.abstract,
          },
          'LAYOUT_HEURISTIC',
          0.75,
          { isBogusTitle: TrustedExtractionService.isBogusTitle },
        );

        if (layoutResults.maxFontSize) {
          ctx.rawMatches.maxFontSize = layoutResults.maxFontSize;
        }
        if (layoutResults.title || layoutResults.authors?.length) {
          ctx.engineUsed = ctx.xmpFound ? 'HYBRID' : 'LAYOUT_HEURISTIC';
        }
      }
    } catch {
      // Layout heuristic extraction failure is non-fatal
    }
  }

  private async executeMeXtractTier(
    ctx: PdfExtractionTierContext,
  ): Promise<void> {
    try {
      const mextractResult = await MeXtractExtractor.extract(ctx.pageText);
      if (!mextractResult?.metadata) return;

      const mMeta = mextractResult.metadata;
      const conf = mextractResult.confidence ?? 0.7;
      let addedFields = false;

      if (
        ctx.mergeFieldIfEmpty('title', mMeta.title, 'MEXTRACT_SLM', conf, {
          allowOverwritePredicate: (cur) => cur === 'Uploaded Document',
        })
      ) {
        addedFields = true;
      }
      if (
        ctx.mergeFieldIfEmpty('authors', mMeta.authors, 'MEXTRACT_SLM', conf)
      ) {
        addedFields = true;
      }
      if (ctx.mergeFieldIfEmpty('year', mMeta.year, 'MEXTRACT_SLM', conf)) {
        addedFields = true;
      }
      if (
        ctx.mergeFieldIfEmpty('journal', mMeta.journal, 'MEXTRACT_SLM', conf)
      ) {
        ctx.mergeFieldIfEmpty(
          'publicationTitle',
          mMeta.journal,
          'MEXTRACT_SLM',
          conf,
        );
        addedFields = true;
      }
      if (
        ctx.mergeFieldIfEmpty('abstract', mMeta.abstract, 'MEXTRACT_SLM', conf)
      ) {
        addedFields = true;
      }
      if (ctx.mergeFieldIfEmpty('doi', mMeta.doi, 'MEXTRACT_SLM', conf)) {
        ctx.rawMatches.detectedDoi = mMeta.doi;
        addedFields = true;
      }

      if (addedFields) {
        ctx.rawMatches.mextract = {
          engine: mextractResult.engine,
          confidence: mextractResult.confidence,
          durationMs: mextractResult.durationMs,
        };
        ctx.engineUsed =
          ctx.xmpFound ||
          ctx.engineUsed === 'LAYOUT_HEURISTIC' ||
          Boolean(ctx.rawMatches.matchedSignatures)
            ? 'HYBRID'
            : 'MEXTRACT_SLM';
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `MeXtract SLM extraction failed non-fatally: ${message}`,
      );
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
        merged.title = normalizeAcademicTitleCase(repaired);
        refinements.push('title-repaired');
      }
    }

    if (refinements.length > 0) rawMatches.refinements = refinements;
  }
}
