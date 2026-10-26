import { Injectable, Logger } from '@nestjs/common';
import {
  ITrustedExtractorPort,
  TrustedExtractionResult,
  ExtractionEngineKind,
} from '@/modules/library/extraction/types/trusted-extraction.types';
import { ItemMetadata } from '@/modules/library/core';
import { XmpParser } from '@/modules/library/extraction/extractors/xmp.parser';
import { AcademicRegexCatalog } from '@/modules/library/core/domain/academic-regex.catalog';
import { LayoutHeuristicExtractor } from '@/modules/library/extraction/extractors/layout-heuristic.extractor';
import { MeXtractExtractor } from '@/modules/library/extraction/extractors/mextract.extractor';
import { MetadataQualityGate } from '@/modules/library/extraction/extractors/metadata-quality.gate';
import { extractText, getDocumentProxy } from 'unpdf';
import {
  cleanAuthorName,
  normalizeAcademicTitleCase,
  isPlausibleAuthorName,
  splitConcatenatedAuthors,
  yearFromArxivId,
  repairFragmentedTitle,
} from '@/modules/library/core';

/**
 * Master Service orchestrating local-first trusted academic metadata extraction.
 *
 * Implements the 4-Tier Zero-Network Cascade:
 *   Tier 1: XmpParser (< 0.5ms) - Reads ISO 16684 binary XML streams.
 *   Tier 2: AcademicRegexCatalog (< 5ms) - Scans ISO 26324 DOI, arXiv, and publisher stamps.
 *   Tier 3: LayoutHeuristicExtractor (< 25ms) - Visual font-size clustering for non-DOI papers.
 *   Tier 4: MeXtractExtractor (< 50ms) - Small Language Model (SLM / Qwen2.5-0.5B-Instruct ONNX)
 *           for complex/unstructured headers, preprints, and non-standard layouts.
 *
 * All steps evaluate through MetadataQualityGate. When totalScore >= 0.85,
 * isSelfSufficient is set to true, instructing downstream ingestion to bypass
 * heavy external APIs and remote round-trips.
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

  /**
   * Executes the autonomous multi-tier extraction pipeline.
   */
  async extract(
    buffer: Buffer,
    preferredFilename?: string,
    pdfDocument?: Awaited<ReturnType<typeof getDocumentProxy>>,
  ): Promise<TrustedExtractionResult> {
    const startedAt = Date.now();
    let engineUsed: ExtractionEngineKind = 'ACADEMIC_REGEX';

    const merged: ItemMetadata = {};
    const rawMatches: Record<string, unknown> = {};

    // TIER 1: Fast-Path XMP Binary Packet Scan (< 0.5ms)
    const xmp = XmpParser.parse(buffer);
    if (xmp) {
      rawMatches.xmpFound = true;
      if (xmp.doi) {
        merged.doi = xmp.doi;
        rawMatches.detectedDoi = xmp.doi;
      }
      if (xmp.title && !TrustedExtractionService.isBogusTitle(xmp.title)) {
        const cleanTitle = xmp.title.replace(/^lncs\s+\d+\s*[-–—:]\s*/i, '');
        merged.title = normalizeAcademicTitleCase(cleanTitle);
      }
      if (xmp.authors && xmp.authors.length > 0) {
        merged.authors = xmp.authors
          .map((a) => cleanAuthorName(a))
          .filter(Boolean);
      }
      if (xmp.year) {
        merged.year = xmp.year;
      }
      if (xmp.publicationDate) {
        merged.publicationDate = xmp.publicationDate;
      }
      if (xmp.journal) {
        merged.journal = xmp.journal;
      }
      if (xmp.publisher) {
        merged.publisher = xmp.publisher;
      }
      if (xmp.description) {
        merged.abstract = xmp.description;
      }
      if (xmp.keywords) {
        merged.keywords = xmp.keywords;
      }
      engineUsed = 'XMP_BINARY';
    }

    // TIER 2: Fast Text Stream & Academic Regex Catalog (< 5ms)
    // Fast-path: Front-matter and header extraction strictly bounded to first 3 pages
    let pageText = '';
    let sharedDoc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined =
      pdfDocument;
    try {
      let docText = '';
      try {
        let doc = sharedDoc;
        if (!doc) {
          const cloned = new Uint8Array(buffer.byteLength);
          cloned.set(buffer);
          doc = await getDocumentProxy(cloned);
          sharedDoc = doc;
        }
        if (doc && doc.numPages > 0) {
          const pagesToRead = Math.min(doc.numPages, 3);
          const pageChunks: string[] = [];
          const readPageText = async (pageNum: number): Promise<string> => {
            const page = await doc.getPage(pageNum);
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
          };

          for (let i = 1; i <= pagesToRead; i++) {
            const pText = await readPageText(i);
            if (pText.length > 0) {
              pageChunks.push(pText);
            }
          }

          // Only scan the front matter (first 1-3 pages) for document identifiers.
          // Do NOT scan tail pages (last 1-2 pages), because in academic papers the tail pages
          // contain the References/Bibliography section and will falsely capture cited papers' DOIs/arXiv IDs.
          if (pageChunks.length > 0) {
            docText = pageChunks.join('\n\n');
          }
        }
      } catch {
        // Fall back to extractText below
      }

      if (docText && docText.trim().length > 0) {
        pageText = docText;
      } else {
        const cloned = new Uint8Array(buffer.byteLength);
        cloned.set(buffer);
        const rawResult = await extractText(cloned, { mergePages: true });
        pageText =
          typeof rawResult === 'string'
            ? rawResult
            : typeof rawResult === 'object' &&
                rawResult !== null &&
                'text' in rawResult &&
                typeof (rawResult as { text: unknown }).text === 'string'
              ? (rawResult as { text: string }).text
              : '';
      }
    } catch {
      // unpdf text extraction failure is non-fatal if XMP succeeded
    }

    if (pageText && pageText.trim().length > 0) {
      const regexResults = AcademicRegexCatalog.scan(pageText);

      // DOI (Favor XMP DOI if valid, else regex DOI)
      if (!merged.doi && regexResults.doi) {
        merged.doi = regexResults.doi;
        rawMatches.detectedDoi = regexResults.doi;
      }
      if (regexResults.arxivId) {
        merged.arxivId = regexResults.arxivId;
        rawMatches.detectedArxivId = regexResults.arxivId;
        if (!merged.doi) merged.doi = `10.48550/arXiv.${regexResults.arxivId}`;
      }
      if (regexResults.pmid && !merged.pmid) {
        merged.pmid = regexResults.pmid;
        rawMatches.detectedPmid = regexResults.pmid;
      }
      if (regexResults.isbn && !merged.isbn) {
        merged.isbn = regexResults.isbn;
      }
      if (regexResults.issn && !merged.issn) {
        merged.issn = regexResults.issn;
      }

      // Publisher Stamps & Dates
      if (regexResults.year && !merged.year) {
        merged.year = regexResults.year;
      }
      if (regexResults.journal && !merged.journal) {
        merged.journal = regexResults.journal;
      }
      if (regexResults.publisher && !merged.publisher) {
        merged.publisher = regexResults.publisher;
      }
      if (regexResults.volume && !merged.volume) {
        merged.volume = regexResults.volume;
      }
      if (regexResults.issue && !merged.issue) {
        merged.issue = regexResults.issue;
      }
      if (regexResults.pages && !merged.pages) {
        merged.pages = regexResults.pages;
      }
      if (regexResults.title && !merged.title) {
        merged.title = regexResults.title;
      }
      if (
        regexResults.authors &&
        (!merged.authors || merged.authors.length === 0)
      ) {
        merged.authors = regexResults.authors;
      }
      if (regexResults.abstract && !merged.abstract) {
        merged.abstract = regexResults.abstract;
      }
      if (
        regexResults.keywords &&
        (!merged.keywords || merged.keywords.length === 0)
      ) {
        merged.keywords = regexResults.keywords;
      }

      if (regexResults.matchedSignatures.length > 0) {
        rawMatches.matchedSignatures =
          regexResults.matchedSignatures.join(', ');
        if (!xmp) engineUsed = 'ACADEMIC_REGEX';
      }
    }

    // TIER 3: Quality Gate Evaluation & Heuristic Zoning (< 20ms)
    let gateEvaluation = MetadataQualityGate.evaluate(merged);

    // If still missing essential Title or Authors, activate typographic LayoutHeuristic
    try {
      if (
        !gateEvaluation.isSelfSufficient &&
        (!merged.title ||
          TrustedExtractionService.isBogusTitle(merged.title) ||
          !merged.authors ||
          merged.authors.length === 0)
      ) {
        const layoutResults = await LayoutHeuristicExtractor.extract(
          buffer,
          sharedDoc,
        );

        if (
          layoutResults.title &&
          (!merged.title || TrustedExtractionService.isBogusTitle(merged.title))
        ) {
          merged.title = layoutResults.title;
        }
        if (
          layoutResults.authors &&
          layoutResults.authors.length > 0 &&
          (!merged.authors || merged.authors.length === 0)
        ) {
          merged.authors = layoutResults.authors;
        }
        if (layoutResults.abstract && !merged.abstract) {
          merged.abstract = layoutResults.abstract;
        }
        if (layoutResults.maxFontSize) {
          rawMatches.maxFontSize = layoutResults.maxFontSize;
        }

        if (layoutResults.title || layoutResults.authors?.length) {
          engineUsed = xmp ? 'HYBRID' : 'LAYOUT_HEURISTIC';
        }
        gateEvaluation = MetadataQualityGate.evaluate(merged);
      }
    } finally {
      if (sharedDoc && sharedDoc !== pdfDocument) {
        try {
          await (
            sharedDoc as { destroy?: () => Promise<void> | void }
          ).destroy?.();
        } catch {
          // Ignore PDF.js cleanup errors
        }
      }
    }

    // TIER 4: MeXtract Intelligent SLM Tier (Qwen2.5-0.5B-Instruct ONNX / Heuristic)
    if (
      !gateEvaluation.isSelfSufficient &&
      pageText &&
      pageText.trim().length > 30
    ) {
      try {
        const mextractResult = await MeXtractExtractor.extract(pageText);
        if (mextractResult?.metadata) {
          const mMeta = mextractResult.metadata;
          let addedFields = false;

          if (
            mMeta.title &&
            (!merged.title || merged.title === 'Uploaded Document')
          ) {
            merged.title = mMeta.title;
            addedFields = true;
          }
          if (
            mMeta.authors &&
            mMeta.authors.length > 0 &&
            (!merged.authors || merged.authors.length === 0)
          ) {
            merged.authors = mMeta.authors;
            addedFields = true;
          }
          if (mMeta.year && !merged.year) {
            merged.year = mMeta.year;
            addedFields = true;
          }
          if (mMeta.journal && !merged.journal) {
            merged.journal = mMeta.journal;
            if (!merged.publicationTitle)
              merged.publicationTitle = mMeta.journal;
            addedFields = true;
          }
          if (mMeta.abstract && !merged.abstract) {
            merged.abstract = mMeta.abstract;
            addedFields = true;
          }
          if (mMeta.doi && !merged.doi) {
            merged.doi = mMeta.doi;
            rawMatches.detectedDoi = mMeta.doi;
            addedFields = true;
          }

          if (addedFields) {
            rawMatches.mextract = {
              engine: mextractResult.engine,
              confidence: mextractResult.confidence,
              durationMs: mextractResult.durationMs,
            };

            if (
              xmp ||
              engineUsed === 'LAYOUT_HEURISTIC' ||
              rawMatches.matchedSignatures
            ) {
              engineUsed = 'HYBRID';
            } else {
              engineUsed = 'MEXTRACT_SLM';
            }

            gateEvaluation = MetadataQualityGate.evaluate(merged);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `MeXtract SLM extraction failed non-fatally: ${message}`,
        );
      }
    }

    // Accuracy refinement (year, author list, fragmented title, arXiv DOI)
    this.refineMetadata(merged, xmp?.year, pageText, rawMatches);
    gateEvaluation = MetadataQualityGate.evaluate(merged);

    // Filename fallback ONLY if title is still missing AND no authoritative identifier exists.
    // When a DOI/arXivId/PMID/ISBN is present, external registry enrichment must supply the canonical title.
    const hasAuthoritativeId = Boolean(
      merged.doi || merged.arxivId || merged.pmid || merged.isbn,
    );
    if (!merged.title && !hasAuthoritativeId && preferredFilename) {
      const cleanSlug = preferredFilename
        .replace(/\.[a-zA-Z0-9]+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (cleanSlug.length > 3) {
        merged.title = normalizeAcademicTitleCase(cleanSlug);
        rawMatches.titleFromFilename = true;
      }
    }

    if (!merged.title) {
      merged.title = 'Uploaded Document';
      rawMatches.titleFromFilename = true;
    }

    const durationMs = Date.now() - startedAt;

    this.logger.debug(
      `Trusted extraction completed in ${durationMs}ms [${engineUsed}] | Score: ${gateEvaluation.breakdown.totalScore} | Sufficient: ${gateEvaluation.isSelfSufficient} | Title: "${merged.title}" | DOI: ${merged.doi || 'none'}`,
    );

    return {
      metadata: merged,
      quality: gateEvaluation.breakdown,
      isSelfSufficient: gateEvaluation.isSelfSufficient,
      missingFields: gateEvaluation.missingFields,
      provenance: {
        extractedAt: new Date().toISOString(),
        engineUsed,
        executionTimeMs: durationMs,
        qualityBreakdown: gateEvaluation.breakdown,
        rawMatches,
      },
    };
  }

  /**
   * Post-processing that corrects systematic first-page extraction errors.
   * Mutates `merged` in place and records what it changed in `rawMatches`
   * so the correction is auditable.
   */
  private refineMetadata(
    merged: ItemMetadata,
    xmpYear: number | undefined,
    pageText: string,
    rawMatches: Record<string, unknown>,
  ): void {
    const refinements: string[] = [];

    // The arXiv ID encodes the submission year; it beats heuristic header years
    // ONLY when the document is not an established journal publication with a formal venue.
    // Formal journal publication years (JMLR, IEEE, ACM, Nature, Elsevier) take precedence over preprints.
    const arxivYear = yearFromArxivId(merged.arxivId);
    if (
      arxivYear &&
      !xmpYear &&
      !merged.journal &&
      merged.year !== arxivYear
    ) {
      rawMatches.yearBeforeRefinement = merged.year;
      merged.year = arxivYear;
      refinements.push('year-from-arxiv-id');
    } else if (
      merged.year &&
      (merged.year < 1900 || merged.year > new Date().getFullYear() + 1)
    ) {
      delete merged.year;
      refinements.push('year-out-of-range-dropped');
    }

    // Authors: split undelimited runs, then drop anything that is not a name.
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

    // Title: repair only when the text layer proves what the title really is.
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
