import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { MetadataRoutingPolicy } from '../metadata/policies/metadata.policy';
import { SsrfGuardService } from '../../common/services/ssrf-guard.service';
import {
  ZoteroTranslatorClient,
  ZoteroItem,
} from '../../../../infra/zotero/zotero-translator.client';

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
 * Modern URL Metadata Capture Provider powered by the self-hosted Zotero
 * Translation Server container (http://localhost:1969).
 *
 * Responsibilities:
 * - SSRF pre-validation (MetadataRoutingPolicy.validateUrl)
 * - HMAC-signed preview token lifecycle (attachPreviewToken, verifyPreviewToken)
 * - Zotero CSL-JSON → CapturedItemMetadata mapping
 *
 * Responsibilities removed (was ~1000 lines):
 * - Custom DOI CSL content negotiation (Zotero handles)
 * - Custom arXiv XML parsing (Zotero handles)
 * - Generic HTML/OpenGraph scraping (Zotero handles + fallback)
 * - Manual DNS/IP SSRF validation (delegated to MetadataRoutingPolicy)
 */
@Injectable()
export class UrlCaptureProvider {
  private readonly logger = new Logger(UrlCaptureProvider.name);
  private readonly tokenTtlMs = 15 * 60 * 1000; // 15 minutes TTL
  private readonly hmacSecret: string;

  constructor(
    private readonly zoteroClient: ZoteroTranslatorClient,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
  ) {
    const configuredSecret =
      this.configService?.get<string>('URL_CAPTURE_SECRET') ||
      process.env.URL_CAPTURE_SECRET ||
      'flux_default_url_capture_secret_key_32_bytes_long_fallback';

    if (!configuredSecret || configuredSecret.length < 32) {
      if (
        process.env.NODE_ENV === 'production' ||
        (configuredSecret && configuredSecret.length < 32)
      ) {
        throw new Error(
          'CRITICAL: URL_CAPTURE_SECRET is missing or less than 32 characters in configuration',
        );
      }
      this.logger.warn(
        'URL_CAPTURE_SECRET is missing in non-production. Utilizing default secure 32-byte baseline.',
      );
      this.hmacSecret =
        'flux_default_url_capture_secret_2026_dev_secure_32bytes';
      return;
    }
    this.hmacSecret = configuredSecret;
  }

  /**
   * Captures bibliographic metadata from a public academic or web URL.
   *
   * Flow:
   * 1. SSRF pre-validation (rejects private/internal IPs & DNS resolution)
   * 2. Delegate to Zotero Translation Server (700+ publisher translators)
   * 3. Map CSL-JSON → CapturedItemMetadata
   * 4. Attach HMAC preview token for secure confirm flow
   *
   * Falls back to a minimal webpage record if Zotero has no translator for the URL.
   */
  async captureFromUrl(
    targetUrl: string,
    context?: { workspaceId?: string; userId?: string },
  ): Promise<CapturedItemMetadata> {
    const canonicalUrl = targetUrl.trim();

    // 1. SSRF validation — reject private/internal/loopback URLs & verify DNS
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

    // 2. Translate via Zotero Translation Server
    let zoteroItems: ZoteroItem[] = [];
    try {
      zoteroItems = await this.zoteroClient.translateUrl(canonicalUrl);
    } catch (err: any) {
      this.logger.warn(`Zotero Translation Server error: ${err?.message}`);
    }

    // 3. Map result or fall back to minimal webpage record
    let captured: CapturedItemMetadata;
    if (zoteroItems.length > 0) {
      captured = this.mapZoteroItem(zoteroItems[0], canonicalUrl);
    } else {
      this.logger.debug(
        `No Zotero translator for URL: ${canonicalUrl} — using minimal fallback`,
      );
      captured = {
        title: 'Web Page',
        url: canonicalUrl,
        itemType: 'webpage',
      };
    }

    // 4. Attach HMAC-signed preview token
    return this.attachPreviewToken(captured, context);
  }

  // ─── Zotero CSL-JSON → CapturedItemMetadata ─────────────────────────────────

  private mapZoteroItem(
    item: ZoteroItem,
    fallbackUrl: string,
  ): CapturedItemMetadata {
    const creators: CapturedItemMetadata['creators'] = [];
    const authors: string[] = [];

    for (const c of item.creators ?? []) {
      if (c.creatorType !== 'author' && creators.length > 0) continue; // Only map authors for authors array
      const firstName = c.firstName?.trim() || undefined;
      const lastName = (c.lastName ?? c.name ?? '').trim();
      if (!lastName && !firstName) continue;

      const fullName = firstName ? `${lastName}, ${firstName}` : lastName;
      if (c.creatorType === 'author' || !c.creatorType) {
        authors.push(fullName);
      }
      creators.push({
        firstName,
        lastName: lastName || 'Unknown',
        fullName,
        creatorType: c.creatorType || 'author',
      });
    }

    // Extract year from Zotero date string (e.g. "2023", "2023-04-15", "April 2023")
    let year: number | undefined;
    const dateStr = item.date ?? '';
    const yearMatch = dateStr.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) year = parseInt(yearMatch[0], 10);

    // Normalize DOI
    const doi = item.DOI
      ? item.DOI.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase()
      : undefined;

    // Extract keywords from Zotero tags
    const keywords = (item.tags ?? [])
      .map((t) => t.tag?.trim())
      .filter(Boolean);

    // Map itemType
    const itemType = this.mapZoteroItemType(item.itemType);

    // Derive accessible PDF URL (e.g. arXiv, open access, or direct .pdf links)
    let pdfUrl: string | undefined;
    const combinedUrl = (item.url || fallbackUrl).trim();
    const arxivMatch =
      combinedUrl.match(
        /(?:arxiv\.org\/(?:abs|html|pdf)\/|arxiv:)(\d{4}\.\d{4,5}(?:v\d+)?)/i,
      ) ||
      (item.extra && item.extra.match(/arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i));

    if (arxivMatch) {
      pdfUrl = `https://arxiv.org/pdf/${arxivMatch[1]}.pdf`;
    } else if (
      combinedUrl.toLowerCase().endsWith('.pdf') ||
      combinedUrl.toLowerCase().includes('.pdf?')
    ) {
      pdfUrl = combinedUrl;
    }

    return {
      title: item.title?.trim() || 'Untitled',
      abstract: item.abstractNote?.trim() || undefined,
      creators: creators.length > 0 ? creators : undefined,
      authors: authors.length > 0 ? authors : undefined,
      year,
      doi,
      url: item.url || fallbackUrl,
      publicationTitle: item.publicationTitle?.trim() || undefined,
      journal: item.publicationTitle?.trim() || undefined,
      publisher: item.publisher?.trim() || undefined,
      place: item.place?.trim() || undefined,
      volume: item.volume?.trim() || undefined,
      issue: item.issue?.trim() || undefined,
      pages: item.pages?.trim() || undefined,
      issn: item.ISSN?.trim() || undefined,
      isbn: item.ISBN?.trim() || undefined,
      language: item.language?.trim() || undefined,
      rights: item.rights?.trim() || undefined,
      license: item.rights?.trim() || undefined,
      shortTitle: item.shortTitle?.trim() || undefined,
      callNumber: item.callNumber?.trim() || undefined,
      archiveLocation: item.archiveLocation?.trim() || undefined,
      libraryCatalog: item.libraryCatalog?.trim() || 'Zotero',
      extra: item.extra?.trim() || undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
      itemType,
      pdfUrl,
      openAccessPdfUrl: pdfUrl,
      rawMetadata: item as Record<string, any>,
    };
  }

  private mapZoteroItemType(
    zoteroType: string,
  ): CapturedItemMetadata['itemType'] {
    const map: Record<string, CapturedItemMetadata['itemType']> = {
      journalArticle: 'journalArticle',
      book: 'book',
      bookSection: 'bookSection',
      conferencePaper: 'conferencePaper',
      thesis: 'thesis',
      report: 'report',
      preprint: 'preprint',
      dataset: 'dataset',
      webpage: 'webpage',
      blogPost: 'blogPost',
      newspaperArticle: 'newspaperArticle',
      magazineArticle: 'magazineArticle',
    };
    return map[zoteroType] ?? zoteroType ?? 'webpage';
  }

  // ─── Preview Token Lifecycle ─────────────────────────────────────────────────

  /**
   * Generates HMAC-signed preview token bound to workspace, user, URL, metadata digest, and expiration.
   */
  attachPreviewToken(
    meta: CapturedItemMetadata,
    context?: { workspaceId?: string; userId?: string },
  ): CapturedItemMetadata {
    const ws = context?.workspaceId || 'unassigned';
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

  /**
   * Verifies metadata integrity and ownership using preview token with constant-time equality.
   */
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
    context?: { workspaceId?: string; userId?: string },
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

    const ws = context?.workspaceId || 'unassigned';
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

  /**
   * Computes deterministic SHA-256 digest of captured metadata fields.
   */
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

  /**
   * Hashes a token for database lookup.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
