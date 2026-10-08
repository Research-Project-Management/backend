import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { MetadataRoutingPolicy } from '../policies/metadata.policy';
import { SsrfGuardService } from '../../shared-kernel/core/services/ssrf-guard.service';

import {
  UrlMetadataScraperService,
  ScrapedUrlResult,
} from '../services/url-metadata-scraper.service';

// ─── Public Interfaces ────────────────────────────────────────────────────────

export interface CapturedItemMetadata {
  title: string;
  abstract?: string;
  creators?: Array<{
    firstName?: string;
    lastName: string;
    fullName?: string;
    creatorType?: string;
  }>;
  authors?: string[];
  year?: number;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  url: string;
  publicationTitle?: string;
  journal?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  section?: string;
  series?: string;
  seriesTitle?: string;
  seriesNumber?: string;
  seriesText?: string;
  issn?: string;
  isbn?: string;
  publicationDate?: string;
  journalAbbr?: string;
  shortTitle?: string;
  language?: string;
  pdfUrl?: string;
  rights?: string;
  license?: string;
  citationKey?: string;
  archive?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  callNumber?: string;
  extra?: string;
  keywords?: string[];
  itemType:
    | 'journalArticle'
    | 'preprint'
    | 'webpage'
    | 'book'
    | 'bookSection'
    | 'conferencePaper'
    | 'report'
    | 'thesis'
    | 'document'
    | (string & {});
  openAccessPdfUrl?: string;
  previewToken?: string;
  extraFields?: Record<string, any>;
  provenance?: any;
  rawMetadata?: Record<string, any>;
}

export interface PreviewTokenVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Modern URL Metadata Capture Provider powered by local-first in-process
 * academic metadata scraping (UrlMetadataScraperService).
 *
 * Responsibilities:
 * - SSRF pre-validation (MetadataRoutingPolicy.validateUrl + SsrfGuardService)
 * - In-process Highwire Press, Dublin Core, JSON-LD, OpenGraph extraction
 * - HMAC-signed preview token lifecycle (attachPreviewToken, verifyPreviewToken)
 * - Scraped metadata -> CapturedItemMetadata mapping
 */
@Injectable()
export class UrlCaptureProvider {
  private readonly logger = new Logger(UrlCaptureProvider.name);
  private readonly tokenTtlMs = 15 * 60 * 1000; // 15 minutes TTL
  private readonly hmacSecret: string;

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional() private readonly urlScraper?: UrlMetadataScraperService,
  ) {
    const configuredSecret =
      (typeof this.configService?.get === 'function'
        ? this.configService.get<string>('URL_CAPTURE_SECRET')
        : undefined) || process.env.URL_CAPTURE_SECRET;

    if (!configuredSecret || configuredSecret.length < 32) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'CRITICAL: URL_CAPTURE_SECRET is missing or less than 32 characters in configuration',
        );
      }
      this.logger.warn(
        'URL_CAPTURE_SECRET is missing or < 32 chars in non-production. Generating ephemeral secure random bytes.',
      );
      this.hmacSecret = randomBytes(32).toString('hex');
      return;
    }
    this.hmacSecret = configuredSecret;
  }

  /**
   * Captures bibliographic metadata from a public academic or web URL.
   *
   * Flow:
   * 1. SSRF pre-validation (rejects private/internal IPs & DNS resolution)
   * 2. In-Process HTML Academic Meta Scraper (< 200ms)
   * 3. Scraped metadata -> CapturedItemMetadata
   * 4. Attach HMAC preview token for secure confirm flow
   */
  async captureFromUrl(
    targetUrl: string,
    context?: {
      scopeId?: string;
      projectId?: string;
      userId?: string;
    },
  ): Promise<CapturedItemMetadata> {
    const canonicalUrl = targetUrl.trim();

    try {
      MetadataRoutingPolicy.validateUrl(canonicalUrl);
      if (this.ssrfGuard) {
        await this.ssrfGuard.assertSafeUrl(canonicalUrl);
      } else {
        const guard = new SsrfGuardService();
        await guard.assertSafeUrl(canonicalUrl);
      }
    } catch (err: any) {
      throw new BadRequestException(
        `SSRF violation: ${err?.message ?? 'Invalid or forbidden URL'}`,
      );
    }

    let scrapedResult: ScrapedUrlResult | null = null;
    if (this.urlScraper) {
      try {
        scrapedResult = await this.urlScraper.scrape(canonicalUrl, {
          scopeId: context?.scopeId,
          userId: context?.userId,
        });
      } catch (err: any) {
        this.logger.debug(
          `In-process urlScraper error for "${canonicalUrl}": ${err?.message}`,
        );
      }
    }

    const isScrapedAuthoritative = Boolean(
      scrapedResult &&
      scrapedResult.title &&
      (scrapedResult.doi ||
        scrapedResult.arxivId ||
        (scrapedResult.authors && scrapedResult.authors.length > 0) ||
        scrapedResult.isPdf),
    );

    let captured: CapturedItemMetadata;

    if (isScrapedAuthoritative && scrapedResult) {
      this.logger.log(
        `[UrlCapture] In-process academic scraper resolved metadata for "${canonicalUrl}" (Title: "${scrapedResult.title}", DOI: ${scrapedResult.doi || 'none'})`,
      );
      captured = this.mapScrapedResult(scrapedResult, canonicalUrl);
    } else if (scrapedResult && scrapedResult.title) {
      captured = this.mapScrapedResult(scrapedResult, canonicalUrl);
    } else {
      this.logger.debug(
        `No metadata extracted for URL: ${canonicalUrl} — using minimal fallback`,
      );
      captured = {
        title: 'Web Page',
        url: canonicalUrl,
        itemType: 'webpage',
      };
    }

    return this.attachPreviewToken(captured, context);
  }

  private mapScrapedResult(
    scraped: ScrapedUrlResult,
    fallbackUrl: string,
  ): CapturedItemMetadata {
    const creators: CapturedItemMetadata['creators'] = [];
    const authors: string[] = [];

    if (Array.isArray(scraped.creators) && scraped.creators.length > 0) {
      for (const c of scraped.creators) {
        const lastName = (c.lastName || c.fullName || 'Unknown').trim();
        const firstName = c.firstName?.trim() || undefined;
        const fullName =
          c.fullName?.trim() ||
          (firstName ? `${lastName}, ${firstName}` : lastName);
        authors.push(fullName);
        creators.push({
          firstName,
          lastName,
          fullName,
          creatorType: c.creatorType || 'author',
        });
      }
    } else if (Array.isArray(scraped.authors) && scraped.authors.length > 0) {
      for (const a of scraped.authors) {
        const cleanName = a.trim();
        if (!cleanName) continue;
        authors.push(cleanName);
        const parts = cleanName.split(/\s+/);
        const lastName = parts.length > 1 ? parts[parts.length - 1] : cleanName;
        const firstName =
          parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined;
        creators.push({
          firstName,
          lastName,
          fullName: cleanName,
          creatorType: 'author',
        });
      }
    }

    const itemType = scraped.arxivId
      ? 'preprint'
      : scraped.doi || scraped.journal || scraped.publicationTitle
        ? 'journalArticle'
        : 'webpage';

    return {
      title: scraped.title || 'Web Page',
      url: fallbackUrl,
      itemType: itemType,
      authors: authors.length > 0 ? authors : undefined,
      creators: creators.length > 0 ? creators : undefined,
      doi: scraped.doi,
      arxivId: scraped.arxivId,
      pmid: scraped.pmid,
      isbn: scraped.isbn,
      issn: scraped.issn,
      year: scraped.year,
      publicationDate: scraped.publicationDate,
      publicationTitle: scraped.publicationTitle || scraped.journal,
      journal: scraped.journal,
      publisher: scraped.publisher,
      abstract: scraped.abstract,
      keywords: scraped.keywords,
      pdfUrl: scraped.pdfUrl,
      volume: scraped.volume,
      issue: scraped.issue,
      pages: scraped.pages,
      extraFields: {
        ...(scraped.fileId ? { fileId: scraped.fileId } : {}),
        ...(scraped.filename ? { filename: scraped.filename } : {}),
        source: 'InProcessUrlScraper',
      },
    };
  }

  attachPreviewToken(
    meta: CapturedItemMetadata,
    context?: {
      scopeId?: string;
      projectId?: string;
      userId?: string;
    },
  ): CapturedItemMetadata {
    const ws = context?.scopeId || context?.projectId || 'unassigned';
    const user = context?.userId || 'unassigned';
    const issuedAt = Date.now();
    const expiresAt = issuedAt + this.tokenTtlMs;
    const nonce = randomBytes(16).toString('hex');

    const metadataDigest = this.calculateMetadataDigest(meta);
    const signaturePayload = `v1:${ws}:${user}:${meta.url}:${metadataDigest}:${issuedAt}:${expiresAt}:${nonce}`;
    const signature = createHmac('sha256', this.hmacSecret)
      .update(signaturePayload)
      .digest('hex');

    const previewToken = `v1.${nonce}.${issuedAt}.${expiresAt}.${signature}`;

    return { ...meta, previewToken };
  }

  verifyPreviewToken(
    canonicalMeta: {
      url?: string;
      title: string;
      doi?: string;
      year?: number;
      publicationTitle?: string;
      abstract?: string;
      itemType?: string;
      creators?: Array<{
        firstName?: string;
        lastName: string;
        creatorType?: string;
      }>;
      tags?: string[];
    },
    token?: string,
    context?: {
      scopeId?: string;
      projectId?: string;
      userId?: string;
    },
  ): PreviewTokenVerificationResult {
    if (!token) return { valid: false, reason: 'missing_token' };

    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') {
      return { valid: false, reason: 'malformed_token' };
    }

    const [, nonce, issuedAtStr, expiresAtStr, receivedSignature] = parts;
    const issuedAt = parseInt(issuedAtStr, 10);
    const expiresAt = parseInt(expiresAtStr, 10);

    if (isNaN(issuedAt) || isNaN(expiresAt)) {
      return { valid: false, reason: 'invalid_token_timestamps' };
    }

    if (Date.now() > expiresAt) {
      return { valid: false, reason: 'token_expired' };
    }

    const ws = context?.scopeId || context?.projectId || 'unassigned';
    const user = context?.userId || 'unassigned';

    const metadataDigest = this.calculateMetadataDigest(canonicalMeta);
    const signaturePayload = `v1:${ws}:${user}:${canonicalMeta.url || ''}:${metadataDigest}:${issuedAt}:${expiresAt}:${nonce}`;
    const expectedSignature = createHmac('sha256', this.hmacSecret)
      .update(signaturePayload)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(receivedSignature, 'hex');

    if (
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      return { valid: true };
    }

    return { valid: false, reason: 'signature_mismatch' };
  }

  calculateMetadataDigest(meta: {
    url?: string;
    title: string;
    doi?: string;
    year?: number;
    publicationTitle?: string;
    abstract?: string;
    itemType?: string;
    creators?: Array<{
      firstName?: string;
      lastName: string;
      creatorType?: string;
    }>;
    tags?: string[];
  }): string {
    const normalizedCreators = (meta.creators || [])
      .map(
        (c) =>
          `${c.creatorType || 'author'}:${c.lastName || ''},${c.firstName || ''}`,
      )
      .sort()
      .join(';');
    const normalizedTags = (meta.tags || []).slice().sort().join(',');
    const canonicalString = `${meta.title || ''}|${meta.doi || ''}|${meta.year || ''}|${meta.publicationTitle || ''}|${meta.url || ''}|${meta.itemType || ''}|${normalizedCreators}|${normalizedTags}`;
    return createHash('sha256').update(canonicalString).digest('hex');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
