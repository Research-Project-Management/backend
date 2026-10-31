import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { MetadataRoutingPolicy } from '@/modules/library/ingestion/policies/metadata.policy';
import {
  METADATA_PORT,
  MetadataPort,
} from '@/modules/library/ingestion/types/metadata.types';
import { SsrfGuardService } from '@/modules/library/core/services/ssrf-guard.service';

import {
  UrlMetadataScraperService,
  ScrapedUrlResult,
} from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import {
  parseCreatorString,
  SubsystemUnavailableException,
  LibraryConfigService,
  libraryConfig,
  deriveDoiFromPublisherUrl,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeAcademicTags,
} from '@/modules/library/core';

// Public Interfaces

export interface CapturedItemMetadata {
  title: string;
  abstract?: string;
  creators?: Array<{
    firstName?: string;
    lastName: string;
    fullName?: string;
    creatorType?: string;
    fieldMode?: number;
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
  edition?: string;
  conferenceName?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  university?: string;
  institution?: string;
  thesisType?: string;
  reportNumber?: string;
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
  extraFields?: Record<string, unknown>;
  provenance?: unknown;
  rawMetadata?: Record<string, unknown>;
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
    @Optional() private readonly libraryConfigService?: LibraryConfigService,
    @Optional()
    @Inject(METADATA_PORT)
    private readonly metadataPort?: MetadataPort,
  ) {
    const configuredSecret =
      this.libraryConfigService?.capture.secret ??
      this.configService?.get<string>('URL_CAPTURE_SECRET') ??
      libraryConfig().capture.secret;

    const isProduction =
      this.libraryConfigService?.app.isProduction ??
      libraryConfig().app.isProduction;

    if (!configuredSecret || configuredSecret.length < 32) {
      if (isProduction) {
        throw new SubsystemUnavailableException(
          'CRITICAL: URL_CAPTURE_SECRET is missing or less than 32 characters in configuration',
          { subsystem: 'UrlCaptureProvider' },
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
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Invalid or forbidden URL';
      throw new BadRequestException(`SSRF violation: ${msg}`);
    }

    let scrapedResult: ScrapedUrlResult | null = null;
    if (this.urlScraper) {
      try {
        scrapedResult = await this.urlScraper.scrape(canonicalUrl, {
          scopeId: context?.scopeId,
          userId: context?.userId,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `In-process urlScraper error for "${canonicalUrl}": ${msg}`,
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

    // Enrich from authoritative registry (CrossRef / arXiv / PubMed) when an identifier is present
    const candidateArxiv =
      captured.arxivId ||
      scrapedResult?.arxivId ||
      normalizeArxivId(canonicalUrl);
    const candidateDoi =
      captured.doi ||
      scrapedResult?.doi ||
      normalizeDoi(canonicalUrl) ||
      deriveDoiFromPublisherUrl(canonicalUrl);
    const candidatePmid =
      captured.pmid ||
      scrapedResult?.pmid ||
      normalizePmid(canonicalUrl) ||
      normalizePmcid(canonicalUrl);

    const lookupQuery = candidateArxiv || candidateDoi || candidatePmid;
    if (this.metadataPort && lookupQuery) {
      try {
        const resolved = await this.metadataPort.resolve({
          query: lookupQuery,
        });
        if (resolved?.metadata && resolved.metadata.title) {
          const rm = resolved.metadata;
          const regTags = normalizeAcademicTags(
            rm.tags || rm.keywords || captured.keywords || [],
          );
          const isArxivPreprint =
            rm.itemType === 'preprint' ||
            Boolean(
              candidateArxiv &&
              (!rm.doi || /^10\.48550\/arxiv\./i.test(String(rm.doi))),
            );
          const cleanArxiv = candidateArxiv
            ? candidateArxiv.replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '')
            : rm.arxivId;
          captured = {
            ...captured,
            title: rm.title || captured.title,
            shortTitle: rm.shortTitle || captured.shortTitle,
            abstract: rm.abstract || captured.abstract,
            itemType: isArxivPreprint
              ? 'preprint'
              : rm.itemType || captured.itemType,
            authors:
              rm.authors && rm.authors.length > 0
                ? rm.authors
                : captured.authors,
            creators:
              rm.creators && rm.creators.length > 0
                ? rm.creators.map((c) => ({
                    firstName: c.firstName || undefined,
                    lastName: c.lastName || c.fullName || 'Unknown',
                    fullName: c.fullName || undefined,
                    creatorType: c.creatorType || 'author',
                    fieldMode: c.fieldMode ?? (c.firstName ? 0 : 1),
                  }))
                : captured.creators,
            year: rm.year ?? captured.year,
            publicationDate:
              rm.publicationDate || rm.date || captured.publicationDate,
            doi:
              isArxivPreprint && cleanArxiv
                ? `10.48550/arXiv.${cleanArxiv}`
                : rm.doi || candidateDoi || captured.doi,
            arxivId: cleanArxiv || captured.arxivId,
            pmid: rm.pmid || candidatePmid || captured.pmid,
            pmcid: rm.pmcid || captured.pmcid,
            isbn: isArxivPreprint ? undefined : rm.isbn || captured.isbn,
            issn: isArxivPreprint ? undefined : rm.issn || captured.issn,
            publicationTitle: isArxivPreprint
              ? 'arXiv'
              : rm.publicationTitle || rm.journal || captured.publicationTitle,
            journal: isArxivPreprint
              ? undefined
              : rm.journal || captured.journal,
            journalAbbr: isArxivPreprint
              ? undefined
              : rm.journalAbbr || captured.journalAbbr,
            publisher: isArxivPreprint
              ? 'arXiv'
              : rm.publisher || captured.publisher,
            volume: isArxivPreprint
              ? undefined
              : rm.volume != null
                ? String(rm.volume)
                : captured.volume,
            issue: isArxivPreprint
              ? undefined
              : rm.issue != null
                ? String(rm.issue)
                : captured.issue,
            pages: isArxivPreprint ? undefined : rm.pages || captured.pages,
            conferenceName: isArxivPreprint
              ? undefined
              : rm.conferenceName || captured.conferenceName,
            proceedingsTitle: isArxivPreprint
              ? undefined
              : rm.proceedingsTitle || captured.proceedingsTitle,
            bookTitle: isArxivPreprint
              ? undefined
              : rm.bookTitle || captured.bookTitle,
            series: isArxivPreprint ? undefined : rm.series || captured.series,
            language: rm.language || captured.language,
            rights: rm.rights || captured.rights,
            license: rm.license || captured.license,
            libraryCatalog: rm.libraryCatalog || captured.libraryCatalog,
            archive: isArxivPreprint ? 'arXiv' : rm.archive || captured.archive,
            extra: rm.extra || captured.extra,
            keywords: regTags.length > 0 ? regTags : captured.keywords,
            openAccessPdfUrl:
              rm.openAccessPdfUrl ||
              captured.openAccessPdfUrl ||
              captured.pdfUrl,
            extraFields: {
              ...(captured.extraFields || {}),
              ...(rm.extraFields || {}),
              ...(isArxivPreprint && cleanArxiv
                ? {
                    repository: 'arXiv',
                    archive: 'arXiv',
                    archiveId: `arXiv:${cleanArxiv}`,
                  }
                : {}),
            },
          };
        }
      } catch (enrichErr: unknown) {
        this.logger.debug(
          `[UrlCapture] Authoritative registry enrichment skipped for "${canonicalUrl}": ${enrichErr instanceof Error ? enrichErr.message : String(enrichErr)}`,
        );
      }
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
          (firstName ? `${firstName} ${lastName}` : lastName);
        if ((c.creatorType || 'author') === 'author') {
          authors.push(fullName);
        }
        creators.push({
          firstName,
          lastName,
          fullName,
          creatorType: c.creatorType || 'author',
          fieldMode: c.fieldMode ?? (firstName ? 0 : 1),
        });
      }
    } else if (Array.isArray(scraped.authors) && scraped.authors.length > 0) {
      for (let i = 0; i < scraped.authors.length; i++) {
        const cleanName = scraped.authors[i].trim();
        if (!cleanName) continue;
        authors.push(cleanName);
        const parsed = parseCreatorString(cleanName, i, 'author');
        creators.push({
          firstName: parsed.firstName,
          lastName: parsed.lastName || cleanName,
          fullName: parsed.fullName,
          creatorType: 'author',
          fieldMode: parsed.fieldMode,
        });
      }
    }

    const itemType =
      scraped.itemType ||
      (scraped.arxivId
        ? 'preprint'
        : scraped.doi || scraped.journal || scraped.publicationTitle
          ? 'journalArticle'
          : 'webpage');

    return {
      title: scraped.title || 'Web Page',
      shortTitle: scraped.shortTitle,
      url: fallbackUrl,
      itemType,
      authors: authors.length > 0 ? authors : undefined,
      creators: creators.length > 0 ? creators : undefined,
      doi: scraped.doi,
      arxivId: scraped.arxivId,
      pmid: scraped.pmid,
      pmcid: scraped.pmcid,
      isbn: scraped.isbn,
      issn: scraped.issn,
      year: scraped.year,
      publicationDate: scraped.publicationDate,
      publicationTitle:
        scraped.publicationTitle ||
        scraped.journal ||
        scraped.proceedingsTitle ||
        scraped.bookTitle,
      journal: scraped.journal,
      journalAbbr: scraped.journalAbbr,
      publisher: scraped.publisher,
      place: scraped.place || scraped.publisherPlace,
      conferenceName: scraped.conferenceName,
      proceedingsTitle: scraped.proceedingsTitle,
      bookTitle: scraped.bookTitle,
      series: scraped.series,
      edition: scraped.edition,
      university: scraped.university,
      institution: scraped.institution,
      thesisType: scraped.thesisType,
      reportNumber: scraped.reportNumber,
      language: scraped.language,
      rights: scraped.rights,
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
    keywords?: string[];
  }): string {
    const normalizedCreators = (meta.creators || [])
      .map(
        (c) =>
          `${c.creatorType || 'author'}:${c.lastName || ''},${c.firstName || ''}`,
      )
      .sort()
      .join(';');
    const rawTags = meta.tags ?? meta.keywords ?? [];
    const normalizedTags = rawTags.slice().sort().join(',');
    const canonicalString = `${meta.title || ''}|${meta.doi || ''}|${meta.year || ''}|${meta.publicationTitle || ''}|${meta.url || ''}|${meta.itemType || ''}|${normalizedCreators}|${normalizedTags}`;
    return createHash('sha256').update(canonicalString).digest('hex');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
