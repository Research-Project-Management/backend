import { Injectable, Logger, Optional } from '@nestjs/common';
import { SubmissionPayload } from '@/modules/library/ingestion/types/submission.types';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';
import { QueryClassifier } from '@/modules/library/ingestion/parsers/query.classifier';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { deriveDoiFromPublisherUrl } from '@/modules/library/core';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import { createCandidate } from './candidate-builder.helper';

@Injectable()
export class IdentifyUrlResolver {
  private readonly logger = new Logger(IdentifyUrlResolver.name);

  constructor(
    private readonly normalizer: NormalizationPolicy,
    @Optional() private readonly urlScraper?: UrlMetadataScraperService,
  ) {}

  async resolve(
    payload: SubmissionPayload & { kind: 'URL' },
    scopeId?: string,
    options?: { forceScrape?: boolean },
  ): Promise<MetadataCandidate> {
    const classified = QueryClassifier.classify(payload.url);
    let extractedRaw: Record<string, unknown> = { url: payload.url };

    if (classified.type === 'DOI') extractedRaw.doi = classified.clean;
    else if (classified.type === 'ARXIV')
      extractedRaw.arxivId = classified.clean;
    else if (classified.type === 'PMID') extractedRaw.pmid = classified.clean;
    else if (classified.type === 'ISBN') extractedRaw.isbn = classified.clean;

    if (!extractedRaw.doi && !extractedRaw.arxivId && !extractedRaw.pmid) {
      const urlDoi = deriveDoiFromPublisherUrl(payload.url);
      if (urlDoi) extractedRaw.doi = urlDoi;
    }

    const hasDirectIdentifier = Boolean(
      extractedRaw.doi || extractedRaw.arxivId || extractedRaw.pmid,
    );

    // Zotero-style: Only scrape HTML if the URL lacks an embedded identifier (or when fallback forceScrape is requested)
    if ((!hasDirectIdentifier || options?.forceScrape) && this.urlScraper) {
      try {
        const scraped = await this.urlScraper.scrape(payload.url, {
          scopeId,
          preferredFilename: payload.filename,
        });

        extractedRaw = {
          ...extractedRaw,
          ...scraped,
          url: payload.url,
          filename: scraped.filename || payload.filename,
          fileUrl: scraped.pdfUrl || (scraped.isPdf ? payload.url : undefined),
        };
      } catch (scrapeErr: unknown) {
        const message =
          scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
        this.logger.warn(
          `UrlMetadataScraper error for "${payload.url}": ${message}`,
        );
      }
    }

    const normalized = this.normalizer.normalize(extractedRaw);
    if (typeof extractedRaw.fileId === 'string')
      normalized.fileId = extractedRaw.fileId;
    if (typeof extractedRaw.filename === 'string')
      normalized.filename = extractedRaw.filename;
    if (typeof extractedRaw.fileUrl === 'string')
      normalized.fileUrl = extractedRaw.fileUrl;
    if (
      !normalized.fileUrl &&
      typeof payload.url === 'string' &&
      /\.pdf(?:$|\?)/i.test(payload.url)
    ) {
      normalized.fileUrl = payload.url;
    }

    const hasIdentifier = Boolean(
      normalized.doi || normalized.arxivId || normalized.pmid,
    );
    const hasTitle = Boolean(
      normalized.title && normalized.title !== 'Untitled Document',
    );

    if (extractedRaw.isBlocked && !hasIdentifier) {
      normalized.extraFields = {
        ...(normalized.extraFields || {}),
        isBlocked: true,
        wafKind: extractedRaw.wafKind,
        promptUploadPdf: true,
        ladderStepReached: extractedRaw.ladderStepReached,
      };
    }

    const confidenceScore = hasIdentifier
      ? 1.0
      : extractedRaw.isBlocked
        ? 0.2
        : hasTitle
          ? 0.88
          : 0.7;

    const sourceKind = hasIdentifier ? 'IDENTIFIER' : 'URL';
    const sourceName = hasIdentifier ? 'DirectIdentifier' : 'UrlCapture';
    const sourceRecordId = hasIdentifier
      ? (normalized.doi as string) ||
        (normalized.arxivId as string) ||
        (normalized.pmid as string) ||
        payload.url
      : payload.url;

    return createCandidate({
      sourceKind,
      sourceName,
      sourceRecordId,
      rawMetadata: extractedRaw,
      normalizedMetadata: normalized,
      confidenceScore,
      normalizer: this.normalizer,
    });
  }
}
