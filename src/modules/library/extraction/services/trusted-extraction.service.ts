import { Injectable, Logger } from '@nestjs/common';
import {
  ITrustedExtractorPort,
  TrustedExtractionResult,
  ExtractionEngineKind,
} from '../types/trusted-extraction.types';
import { ItemMetadata } from '../../shared-kernel';
import {
  XmpParser,
  AcademicRegexCatalog,
  LayoutHeuristicExtractor,
  MeXtractExtractor,
  MetadataQualityGate,
} from '../extractors';
import { extractText } from 'unpdf';
import {
  cleanAuthorName,
  normalizeAcademicTitleCase,
} from '../../shared-kernel/utils/bibliographic.utils';

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

  /**
   * Executes the autonomous multi-tier extraction pipeline.
   */
  async extract(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult> {
    const startedAt = Date.now();
    let engineUsed: ExtractionEngineKind = 'ACADEMIC_REGEX';

    const merged: ItemMetadata = {};
    const rawMatches: Record<string, any> = {};

    // ── TIER 1: Fast-Path XMP Binary Packet Scan (< 0.5ms) ──────────────────
    const xmp = XmpParser.parse(buffer);
    if (xmp) {
      rawMatches.xmpFound = true;
      if (xmp.doi) {
        merged.doi = xmp.doi;
        rawMatches.detectedDoi = xmp.doi;
      }
      if (xmp.title) {
        merged.title = normalizeAcademicTitleCase(xmp.title);
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

    // ── TIER 2: Fast Text Stream & Academic Regex Catalog (< 5ms) ───────────
    let pageText = '';
    try {
      const cloned = new Uint8Array(buffer.byteLength);
      cloned.set(buffer);
      const rawResult = await extractText(cloned, { mergePages: true });
      pageText =
        typeof rawResult === 'string'
          ? rawResult
          : (rawResult as any)?.text || '';
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

    // ── TIER 3: Quality Gate Evaluation & Heuristic Zoning (< 20ms) ──────────
    let gateEvaluation = MetadataQualityGate.evaluate(merged);

    // If still missing essential Title or Authors, activate typographic LayoutHeuristic
    if (
      !gateEvaluation.isSelfSufficient &&
      (!merged.title || !merged.authors || merged.authors.length === 0)
    ) {
      const layoutResults = await LayoutHeuristicExtractor.extract(buffer);

      if (layoutResults.title && !merged.title) {
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

    // ── TIER 4: MeXtract Intelligent SLM Tier (Qwen2.5-0.5B-Instruct ONNX / Heuristic) ──
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
      } catch (err: any) {
        this.logger.warn(
          `MeXtract SLM extraction failed non-fatally: ${err?.message}`,
        );
      }
    }

    // Filename fallback if title is still missing
    if (!merged.title && preferredFilename) {
      const cleanSlug = preferredFilename
        .replace(/\.[a-zA-Z0-9]+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim();
      if (cleanSlug.length > 3) {
        merged.title = normalizeAcademicTitleCase(cleanSlug);
      }
    }

    if (!merged.title) {
      merged.title = 'Uploaded Document';
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
}
