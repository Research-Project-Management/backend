import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import {
  WEB_FETCH_PORT,
  IWebFetchPort,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  SsrfGuardService,
  DEFAULT_BROWSER_FETCH_HEADERS,
  DEFAULT_SAFE_REDIRECT_MAX_HOPS,
  UnsafeRedirectError,
} from '@/modules/library/core/services/ssrf-guard.service';
import { MetadataRoutingPolicy } from '@/modules/library/ingestion/policies/metadata.policy';
import {
  EXTRACTION_FACADE,
  IExtractionFacade,
  normalizeDoi,
  normalizeArxivId,
  isBotChallengePage,
  deriveDoiFromPublisherUrl,
  readSafeResponseBuffer,
  readSafeResponseText,
} from '@/modules/library/core';
import {
  PublisherDomExtractor,
  FallbackMeta,
  JSONLD_TYPES,
  JSONLD_TYPE_TO_ITEM_TYPE,
} from './publisher-dom.extractor';
import {
  HtmlMetaTagExtractor,
  ScrapedUrlResult,
  ScrapedCreator,
  MetaEntry,
} from './html-meta-tag.extractor';

export type { ScrapedUrlResult, ScrapedCreator, MetaEntry, FallbackMeta };
export {
  PublisherDomExtractor,
  HtmlMetaTagExtractor,
  JSONLD_TYPES,
  JSONLD_TYPE_TO_ITEM_TYPE,
};

/** Canonical actor identifier for automated system-level ingestion downloads */
export const SYSTEM_INGESTION_USER_ID = 'system';

const FETCH_TIMEOUT_MS = 14000;

@Injectable()
export class UrlMetadataScraperService {
  private readonly logger = new Logger(UrlMetadataScraperService.name);
  private readonly publisherDomExtractor: PublisherDomExtractor;
  private readonly htmlMetaTagExtractor: HtmlMetaTagExtractor;

  constructor(
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(EXTRACTION_FACADE)
    private readonly extractionGateway?: IExtractionFacade,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional()
    @Inject(WEB_FETCH_PORT)
    private readonly webFetch?: IWebFetchPort,
    @Optional() publisherDomExtractor?: PublisherDomExtractor,
    @Optional() htmlMetaTagExtractor?: HtmlMetaTagExtractor,
  ) {
    this.publisherDomExtractor =
      publisherDomExtractor ?? new PublisherDomExtractor();
    this.htmlMetaTagExtractor =
      htmlMetaTagExtractor ??
      new HtmlMetaTagExtractor(this.publisherDomExtractor);
  }

  /**
   * Extracts a readable title and filename hint from the URL pathname slug.
   */
  extractSlugMetadata(rawUrl: string): { title?: string; filename: string } {
    return this.publisherDomExtractor.extractSlugMetadata(rawUrl);
  }

  private async assertSafeUrl(url: string): Promise<void> {
    if (this.ssrfGuard) {
      await this.ssrfGuard.assertSafeUrl(url);
    } else {
      await MetadataRoutingPolicy.assertSafeUrl(url);
    }
  }

  private async fetchWithSafeRedirects(
    startUrl: string,
  ): Promise<{ response: Response; finalUrl: string }> {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    return SsrfGuardService.executeSafeRedirectFetch(
      startUrl,
      {
        headers: DEFAULT_BROWSER_FETCH_HEADERS,
        signal,
      },
      {
        maxRedirects: DEFAULT_SAFE_REDIRECT_MAX_HOPS,
        validateUrl: async (nextUrl) => {
          try {
            await this.assertSafeUrl(nextUrl);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new UnsafeRedirectError(
              `Redirect target "${nextUrl}" rejected: ${msg}`,
            );
          }
        },
      },
    );
  }

  async scrape(
    url: string,
    options?: {
      scopeId?: string;
      userId?: string;
      preferredFilename?: string;
    },
  ): Promise<ScrapedUrlResult> {
    const canonicalUrl = url.trim();
    const slugHint = this.extractSlugMetadata(canonicalUrl);
    const urlDoi = deriveDoiFromPublisherUrl(canonicalUrl);

    const fallbackResult = (): ScrapedUrlResult => ({
      url: canonicalUrl,
      isPdf: false,
      title: slugHint.title,
      filename: slugHint.filename,
      doi: urlDoi || undefined,
      confidence: 0.5,
    });

    if (this.webFetch) {
      const ladderRes = await this.webFetch.fetch(canonicalUrl, {
        scopeId: options?.scopeId,
        userId: options?.userId,
        preferredFilename: options?.preferredFilename,
      });

      if (ladderRes.isBlocked) {
        return {
          url: canonicalUrl,
          isPdf: false,
          filename: slugHint.filename,
          title: urlDoi ? undefined : slugHint.title,
          doi: urlDoi || ladderRes.derivedIdentifier?.doi || undefined,
          arxivId: ladderRes.derivedIdentifier?.arxivId,
          pmid: ladderRes.derivedIdentifier?.pmid,
          confidence: urlDoi ? 0.9 : 0.3,
          isBlocked: true,
          wafKind: ladderRes.wafKind,
          promptUploadPdf: true,
          ladderStepReached: ladderRes.ladderStepReached,
        };
      }

      if (ladderRes.mirrorMetadata) {
        const m = ladderRes.mirrorMetadata as typeof ladderRes.mirrorMetadata &
          Partial<ScrapedUrlResult>;
        return {
          url: canonicalUrl,
          isPdf: false,
          filename: slugHint.filename,
          title: m.title || slugHint.title,
          authors: m.authors,
          creators:
            m.creators && m.creators.length > 0
              ? m.creators
              : m.authors?.map((a, idx) =>
                  this.htmlMetaTagExtractor.toCreator(a, idx, 'author'),
                ),
          doi: m.doi || urlDoi || undefined,
          arxivId: m.arxivId,
          pmid: m.pmid,
          pmcid: m.pmcid,
          isbn: m.isbn,
          issn: m.issn,
          year: m.year,
          publicationDate: m.publicationDate,
          publicationTitle: m.journal,
          journal: m.journal,
          publisher: m.publisher,
          volume: m.volume,
          issue: m.issue,
          pages: m.pages,
          keywords: m.keywords,
          itemType: m.itemType,
          abstract: m.abstract,
          pdfUrl: m.pdfUrl,
          confidence: 0.95,
          isBlocked: false,
          ladderStepReached: 2,
        };
      }

      if (ladderRes.isPdf && ladderRes.bodyBuffer) {
        const pdfProcessed = await this.processPdfBuffer(
          ladderRes.bodyBuffer,
          canonicalUrl,
          slugHint,
          options,
        );
        if (pdfProcessed) return pdfProcessed;
      }

      if (ladderRes.bodyText) {
        return this.processHtmlText(
          ladderRes.bodyText,
          ladderRes.finalUrl || canonicalUrl,
          canonicalUrl,
          slugHint,
          urlDoi,
        );
      }

      return fallbackResult();
    }

    try {
      await this.assertSafeUrl(canonicalUrl);
    } catch (ssrfErr: unknown) {
      const msg = ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr);
      this.logger.warn(`SSRF rejection for URL "${canonicalUrl}": ${msg}`);
      return fallbackResult();
    }

    let response: Response;
    let finalUrl = canonicalUrl;
    try {
      const fetched = await this.fetchWithSafeRedirects(canonicalUrl);
      response = fetched.response;
      finalUrl = fetched.finalUrl;
    } catch (fetchErr: unknown) {
      if (fetchErr instanceof UnsafeRedirectError) {
        this.logger.warn(
          `SSRF rejection on redirect for URL "${canonicalUrl}": ${fetchErr.message}`,
        );
      } else {
        const msg =
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        this.logger.warn(`Failed to fetch URL "${canonicalUrl}": ${msg}`);
      }
      return fallbackResult();
    }

    if (!response.ok) {
      this.logger.warn(
        `HTTP ${response.status} when fetching URL "${canonicalUrl}"`,
      );
      return fallbackResult();
    }

    const contentType = (
      response.headers.get('content-type') || ''
    ).toLowerCase();
    const isPdfContent =
      contentType.includes('application/pdf') ||
      canonicalUrl.toLowerCase().endsWith('.pdf') ||
      new URL(canonicalUrl).pathname.toLowerCase().endsWith('.pdf') ||
      new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf');

    if (isPdfContent) {
      try {
        const buffer = await readSafeResponseBuffer(response);
        const pdfProcessed = await this.processPdfBuffer(
          buffer,
          canonicalUrl,
          slugHint,
          options,
        );
        if (pdfProcessed) return pdfProcessed;
      } catch (pdfProcessErr: unknown) {
        const msg =
          pdfProcessErr instanceof Error
            ? pdfProcessErr.message
            : String(pdfProcessErr);
        this.logger.warn(
          `Error downloading/processing PDF from "${canonicalUrl}": ${msg}`,
        );
      }
    }

    try {
      const htmlText = await readSafeResponseText(response);
      return this.processHtmlText(
        htmlText,
        finalUrl,
        canonicalUrl,
        slugHint,
        urlDoi,
      );
    } catch (htmlErr: unknown) {
      const msg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
      this.logger.warn(`Error parsing HTML from "${canonicalUrl}": ${msg}`);
      return fallbackResult();
    }
  }

  private async processPdfBuffer(
    buffer: Buffer,
    canonicalUrl: string,
    slugHint: { title?: string; filename: string },
    options?: {
      scopeId?: string;
      userId?: string;
      preferredFilename?: string;
    },
  ): Promise<ScrapedUrlResult | null> {
    const isPdfMagic =
      buffer.length >= 4 &&
      buffer[0] === 0x25 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x44 &&
      buffer[3] === 0x46;

    if (!isPdfMagic) return null;

    const effectiveFilename = options?.preferredFilename || slugHint.filename;
    let fileId: string | undefined;

    if (this.storagePort) {
      try {
        const uploadRes = await this.storagePort.uploadFile({
          userId: options?.userId || SYSTEM_INGESTION_USER_ID,
          filename: effectiveFilename,
          buffer,
          mimeType: 'application/pdf',
          projectId:
            options?.scopeId && options.scopeId !== 'user'
              ? options.scopeId
              : undefined,
          source: 'url_pdf_download',
        });
        fileId = uploadRes?.fileId;
        this.logger.log(
          `Stored downloaded PDF for "${canonicalUrl}" with fileId: ${fileId}`,
        );
      } catch (storageErr: unknown) {
        const msg =
          storageErr instanceof Error ? storageErr.message : String(storageErr);
        this.logger.warn(`Failed to persist downloaded PDF to storage: ${msg}`);
      }
    }

    let pdfExtracted: Record<string, unknown> = {};
    if (this.extractionGateway?.extractDocumentFromBuffer) {
      try {
        const doc = await this.extractionGateway.extractDocumentFromBuffer(
          buffer,
          {
            headerOnly: true,
          },
        );
        pdfExtracted =
          (doc?.metadata as unknown as Record<string, unknown>) || {};
      } catch (pdfErr: unknown) {
        const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
        this.logger.warn(`ExtractionGateway pdf extraction failed: ${msg}`);
      }
    }

    let binaryDoi: string | undefined;
    const scanBuffer = buffer
      .slice(0, Math.min(buffer.length, 65536))
      .toString('utf-8');
    const doiMatch = scanBuffer.match(
      /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9<>+=[\]~]+)\b/i,
    );
    if (doiMatch) {
      binaryDoi = normalizeDoi(doiMatch[1]);
    }

    let binaryArxiv: string | undefined;
    const arxivMatch = scanBuffer.match(
      /\barXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)\b/i,
    );
    if (arxivMatch) {
      binaryArxiv = normalizeArxivId(arxivMatch[1]);
    }

    let urlArxiv: string | undefined;
    const arxivUrlMatch = canonicalUrl.match(
      /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:)([\d.]+v?\d*)/i,
    );
    if (arxivUrlMatch) {
      urlArxiv = normalizeArxivId(arxivUrlMatch[1]);
    }

    const resolvedDoi =
      (typeof pdfExtracted.doi === 'string' ? pdfExtracted.doi : undefined) ||
      binaryDoi;
    const resolvedArxiv =
      (typeof pdfExtracted.arxivId === 'string'
        ? pdfExtracted.arxivId
        : undefined) ||
      binaryArxiv ||
      urlArxiv;
    const resolvedTitle =
      typeof pdfExtracted.title === 'string' &&
      pdfExtracted.title !== 'Untitled Document' &&
      pdfExtracted.title.length > 5
        ? pdfExtracted.title
        : slugHint.title;

    return {
      url: canonicalUrl,
      isPdf: true,
      ...(fileId ? {} : { fileBuffer: buffer }),
      filename: effectiveFilename,
      fileId,
      title: resolvedTitle,
      authors: Array.isArray(pdfExtracted.authors)
        ? (pdfExtracted.authors as string[])
        : undefined,
      creators: Array.isArray(pdfExtracted.creators)
        ? (pdfExtracted.creators as ScrapedUrlResult['creators'])
        : undefined,
      doi: resolvedDoi,
      arxivId: resolvedArxiv,
      year:
        typeof pdfExtracted.year === 'number'
          ? pdfExtracted.year
          : typeof pdfExtracted.year === 'string'
            ? parseInt(pdfExtracted.year, 10) || undefined
            : undefined,
      publicationDate:
        typeof pdfExtracted.publicationDate === 'string'
          ? pdfExtracted.publicationDate
          : undefined,
      publicationTitle:
        typeof pdfExtracted.journal === 'string'
          ? pdfExtracted.journal
          : typeof pdfExtracted.conferenceName === 'string'
            ? pdfExtracted.conferenceName
            : undefined,
      journal:
        typeof pdfExtracted.journal === 'string'
          ? pdfExtracted.journal
          : undefined,
      publisher:
        typeof pdfExtracted.publisher === 'string'
          ? pdfExtracted.publisher
          : undefined,
      abstract:
        typeof pdfExtracted.abstract === 'string'
          ? pdfExtracted.abstract
          : undefined,
      keywords: Array.isArray(pdfExtracted.keywords)
        ? (pdfExtracted.keywords as string[])
        : undefined,
      confidence:
        resolvedDoi || resolvedArxiv ? 0.95 : resolvedTitle ? 0.85 : 0.7,
    };
  }

  private processHtmlText(
    htmlText: string,
    finalUrl: string,
    canonicalUrl: string,
    slugHint: { title?: string; filename: string },
    urlDoi?: string,
  ): ScrapedUrlResult {
    if (isBotChallengePage(htmlText)) {
      this.logger.warn(
        `Bot-challenge page detected for "${canonicalUrl}" — ignoring page metadata${urlDoi ? `, using URL-derived DOI ${urlDoi}` : ''}`,
      );
      return {
        url: canonicalUrl,
        isPdf: false,
        filename: slugHint.filename,
        title: urlDoi ? undefined : slugHint.title,
        doi: urlDoi || undefined,
        confidence: urlDoi ? 0.9 : 0.3,
        isBlocked: true,
        wafKind: 'BOT_CHALLENGE',
        promptUploadPdf: true,
      };
    }

    const parsedHtml = this.extractHtmlMetadata(htmlText, finalUrl);
    const resolvedDoi = parsedHtml.doi || urlDoi || undefined;
    const resolvedTitle = parsedHtml.title || slugHint.title;

    return {
      url: canonicalUrl,
      isPdf: false,
      filename: slugHint.filename,
      title: resolvedTitle,
      shortTitle: parsedHtml.shortTitle,
      authors: parsedHtml.authors,
      creators: parsedHtml.creators,
      doi: resolvedDoi,
      arxivId: parsedHtml.arxivId,
      pmid: parsedHtml.pmid,
      pmcid: parsedHtml.pmcid,
      isbn: parsedHtml.isbn,
      issn: parsedHtml.issn,
      year: parsedHtml.year,
      publicationDate: parsedHtml.publicationDate,
      publicationTitle: parsedHtml.publicationTitle,
      journal: parsedHtml.journal,
      journalAbbr: parsedHtml.journalAbbr,
      publisher: parsedHtml.publisher,
      abstract: parsedHtml.abstract,
      keywords: parsedHtml.keywords,
      pdfUrl: parsedHtml.pdfUrl,
      volume: parsedHtml.volume,
      issue: parsedHtml.issue,
      pages: parsedHtml.pages,
      language: parsedHtml.language,
      publisherPlace: parsedHtml.publisherPlace,
      place: parsedHtml.place,
      conferenceName: parsedHtml.conferenceName,
      proceedingsTitle: parsedHtml.proceedingsTitle,
      bookTitle: parsedHtml.bookTitle,
      series: parsedHtml.series,
      edition: parsedHtml.edition,
      rights: parsedHtml.rights,
      institution: parsedHtml.institution,
      university: parsedHtml.university,
      thesisType: parsedHtml.thesisType,
      reportNumber: parsedHtml.reportNumber,
      itemType: parsedHtml.itemType,
      confidence:
        resolvedDoi || parsedHtml.arxivId || parsedHtml.pmid
          ? 0.95
          : resolvedTitle
            ? 0.85
            : 0.6,
    };
  }

  extractHtmlMetadata(
    html: string,
    pageUrl: string,
  ): Partial<ScrapedUrlResult> {
    return this.htmlMetaTagExtractor.extractHtmlMetadata(html, pageUrl);
  }

  cleanPublisherTitle(rawTitle: string): string {
    return this.publisherDomExtractor.cleanPublisherTitle(rawTitle);
  }

  extractJsonLdMetadata(html: string): FallbackMeta {
    return this.publisherDomExtractor.extractJsonLdMetadata(html);
  }

  extractCoinsMetadata(html: string): FallbackMeta {
    return this.publisherDomExtractor.extractCoinsMetadata(html);
  }
}
