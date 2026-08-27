import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as dns from 'dns/promises';
import * as net from 'net';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'crypto';

export interface CapturedPaperMetadata {
  title: string;
  abstract?: string;
  creators?: Array<{
    firstName?: string;
    lastName: string;
    creatorType?: string;
  }>;
  year?: number;
  doi?: string;
  url: string;
  publicationTitle?: string;
  itemType:
    'journalArticle' | 'preprint' | 'webpage' | 'book' | 'conferencePaper';
  previewToken?: string;
  rawMetadata?: Record<string, any>;
}

export interface PreviewTokenVerificationResult {
  valid: boolean;
  reason?: string;
}

@Injectable()
export class UrlCaptureConnector {
  private readonly logger = new Logger(UrlCaptureConnector.name);
  private readonly maxRedirects = 5;
  private readonly maxBodySizeBytes = 5 * 1024 * 1024; // 5 MB
  private readonly timeoutMs = 8000;
  private readonly tokenTtlMs = 15 * 60 * 1000; // 15 minutes TTL
  private readonly hmacSecret: string;

  constructor(private readonly configService?: ConfigService) {
    const configuredSecret =
      this.configService?.get<string>('URL_CAPTURE_SECRET') ||
      process.env.URL_CAPTURE_SECRET;

    if (!configuredSecret || configuredSecret.length < 32) {
      throw new Error(
        'CRITICAL: URL_CAPTURE_SECRET is missing or less than 32 characters in configuration',
      );
    }
    this.hmacSecret = configuredSecret;
  }

  /**
   * Captures and parses bibliographic metadata from any public academic or web URL.
   */
  async captureFromUrl(
    targetUrl: string,
    context?: { workspaceId?: string; userId?: string },
  ): Promise<CapturedPaperMetadata> {
    const canonicalUrl = targetUrl.trim();

    // 1. Initial URL validation
    await this.validateUrlSecurity(canonicalUrl);

    // 2. Check specialized academic protocols
    const doiMatch = canonicalUrl.match(
      /doi\.org\/(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i,
    );
    if (doiMatch) {
      const doiResult = await this.resolveDoi(doiMatch[1], canonicalUrl);
      return this.attachPreviewToken(doiResult, context);
    }

    const arxivMatch = canonicalUrl.match(
      /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i,
    );
    if (arxivMatch) {
      const arxivResult = await this.resolveArxiv(arxivMatch[1], canonicalUrl);
      return this.attachPreviewToken(arxivResult, context);
    }

    // 3. Fallback to generic safe HTML / OpenGraph / CSL metadata scraper
    const genericResult = await this.scrapeGenericWebpage(canonicalUrl);
    return this.attachPreviewToken(genericResult, context);
  }

  /**
   * Resolves DOI via standard Crossref / Citation Style Language (CSL) Content Negotiation.
   */
  async resolveDoi(
    doi: string,
    originalUrl: string,
  ): Promise<CapturedPaperMetadata> {
    try {
      const doiUrl = `https://doi.org/${encodeURIComponent(doi)}`;
      const { text, contentType } = await this.fetchWithManualRedirects(
        doiUrl,
        {
          headers: {
            Accept: 'application/vnd.citationstyles.csl+json, application/json',
            'User-Agent':
              'FluxResearchPlatform/1.0 (mailto:support@flux.local)',
          },
        },
      );

      if (
        !contentType.includes('application/vnd.citationstyles.csl+json') &&
        !contentType.includes('application/json')
      ) {
        return this.scrapeGenericWebpage(originalUrl);
      }

      const csl = JSON.parse(text);
      const creators = (csl.author || []).map((a: any) => ({
        firstName: a.given ? String(a.given).slice(0, 100) : undefined,
        lastName: a.family || a.name || 'Unknown',
        creatorType: 'author',
      }));

      const year =
        csl.issued?.['date-parts']?.[0]?.[0] ||
        (csl.created?.['date-parts']?.[0]?.[0]
          ? Number(csl.created['date-parts'][0][0])
          : undefined);

      const title = String(csl.title || 'Untitled Publication')
        .slice(0, 500)
        .replace(/\s+/g, ' ')
        .trim();

      const abstract = csl.abstract
        ? String(csl.abstract)
            .replace(/<[^>]*>?/gm, '')
            .slice(0, 15000)
        : undefined;

      return {
        title,
        abstract,
        creators,
        year: year ? Number(year) : undefined,
        doi: csl.DOI || doi,
        url: csl.URL || originalUrl,
        publicationTitle: csl['container-title'] || undefined,
        itemType: 'journalArticle',
        rawMetadata: csl,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`CSL DOI negotiation failed for ${doi}: ${err.message}`);
      return this.scrapeGenericWebpage(originalUrl);
    }
  }

  /**
   * Resolves arXiv preprint metadata via arXiv Export API.
   */
  async resolveArxiv(
    arxivId: string,
    originalUrl: string,
  ): Promise<CapturedPaperMetadata> {
    try {
      const cleanId = arxivId.replace(/^arxiv:/i, '');
      const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
      const { text } = await this.fetchWithManualRedirects(apiUrl);

      const titleMatch = text.match(
        /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/,
      );
      const summaryMatch = text.match(
        /<entry>[\s\S]*?<summary>([\s\S]*?)<\/summary>/,
      );
      const publishedMatch = text.match(
        /<entry>[\s\S]*?<published>(\d{4})-\d{2}-\d{2}/,
      );
      const doiMatch = text.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);

      const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/g;
      const creators: Array<{ firstName?: string; lastName: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = authorRegex.exec(text)) !== null) {
        const fullName = m[1].replace(/\s+/g, ' ').trim();
        const parts = fullName.split(' ');
        if (parts.length > 1) {
          creators.push({
            firstName: parts.slice(0, -1).join(' '),
            lastName: parts[parts.length - 1],
          });
        } else {
          creators.push({ lastName: fullName });
        }
      }

      const title = titleMatch
        ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 500)
        : `arXiv:${cleanId}`;

      const abstract = summaryMatch
        ? summaryMatch[1].replace(/\s+/g, ' ').trim().slice(0, 15000)
        : undefined;

      const year = publishedMatch ? parseInt(publishedMatch[1], 10) : undefined;

      return {
        title,
        abstract,
        creators: creators.length > 0 ? creators : undefined,
        year,
        doi: doiMatch ? doiMatch[1].trim() : undefined,
        url: `https://arxiv.org/abs/${cleanId}`,
        publicationTitle: 'arXiv',
        itemType: 'preprint',
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`arXiv API query failed for ${arxivId}: ${err.message}`);
      return this.scrapeGenericWebpage(originalUrl);
    }
  }

  /**
   * Safe generic webpage scraper extracting OpenGraph, Highwire Press, and standard HTML meta tags.
   */
  async scrapeGenericWebpage(
    targetUrl: string,
  ): Promise<CapturedPaperMetadata> {
    try {
      const { text, finalUrl } = await this.fetchWithManualRedirects(
        targetUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
      );

      const titleMatch =
        text.match(
          /<meta\s+(?:property|name)=["'](?:citation_title|og:title|twitter:title)["']\s+content=["'](.*?)["']/i,
        ) ||
        text.match(
          /<meta\s+content=["'](.*?)["']\s+(?:property|name)=["'](?:citation_title|og:title|twitter:title)["']/i,
        ) ||
        text.match(/<title[^>]*>(.*?)<\/title>/i);

      const abstractMatch =
        text.match(
          /<meta\s+(?:property|name)=["'](?:citation_abstract|og:description|description)["']\s+content=["'](.*?)["']/i,
        ) ||
        text.match(
          /<meta\s+content=["'](.*?)["']\s+(?:property|name)=["'](?:citation_abstract|og:description|description)["']/i,
        );

      const doiMatch =
        text.match(
          /<meta\s+(?:property|name)=["']citation_doi["']\s+content=["'](.*?)["']/i,
        ) ||
        text.match(
          /<meta\s+content=["'](.*?)["']\s+(?:property|name)=["']citation_doi["']/i,
        );

      const dateMatch =
        text.match(
          /<meta\s+(?:property|name)=["'](?:citation_publication_date|citation_date|article:published_time)["']\s+content=["'](.*?)["']/i,
        ) ||
        text.match(
          /<meta\s+content=["'](.*?)["']\s+(?:property|name)=["'](?:citation_publication_date|citation_date|article:published_time)["']/i,
        );

      const journalMatch =
        text.match(
          /<meta\s+(?:property|name)=["']citation_journal_title["']\s+content=["'](.*?)["']/i,
        ) ||
        text.match(
          /<meta\s+content=["'](.*?)["']\s+(?:property|name)=["']citation_journal_title["']/i,
        );

      // Highwire Press authors
      const authorRegex =
        /<meta\s+(?:property|name)=["']citation_author["']\s+content=["'](.*?)["']/gi;
      const creators: Array<{ firstName?: string; lastName: string }> = [];
      let authorMatch: RegExpExecArray | null;
      while ((authorMatch = authorRegex.exec(text)) !== null) {
        const name = authorMatch[1].trim();
        if (name.includes(',')) {
          const [last, first] = name.split(',').map((s) => s.trim());
          creators.push({ firstName: first, lastName: last });
        } else {
          creators.push({ lastName: name });
        }
      }

      const title = titleMatch
        ? titleMatch[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim()
            .slice(0, 500)
        : finalUrl;

      const abstract = abstractMatch
        ? abstractMatch[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim()
            .slice(0, 15000)
        : undefined;

      let year: number | undefined;
      if (dateMatch) {
        const yMatch = dateMatch[1].match(/\b(19\d\d|20\d\d)\b/);
        if (yMatch) year = parseInt(yMatch[1], 10);
      }

      return {
        title: title || finalUrl,
        abstract,
        creators: creators.length > 0 ? creators : undefined,
        year,
        doi: doiMatch ? doiMatch[1].trim() : undefined,
        url: finalUrl,
        publicationTitle: journalMatch ? journalMatch[1].trim() : undefined,
        itemType: doiMatch ? 'journalArticle' : 'webpage',
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;

      this.logger.warn(
        `Generic scrape failed for ${targetUrl}: ${err.message}`,
      );
      return {
        title: targetUrl.slice(0, 500),
        url: targetUrl,
        itemType: 'webpage',
      };
    }
  }

  /**
   * Fetches target URL with manual redirect tracking, SSRF validation on every hop, and bounded streaming body reader.
   */
  async fetchWithManualRedirects(
    initialUrl: string,
    options: { headers?: Record<string, string> } = {},
  ): Promise<{ text: string; contentType: string; finalUrl: string }> {
    let currentUrl = initialUrl;
    const visitedUrls = new Set<string>();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      for (let hop = 0; hop <= this.maxRedirects; hop++) {
        if (visitedUrls.has(currentUrl)) {
          throw new BadRequestException(
            'Redirect loop detected during URL capture',
          );
        }
        visitedUrls.add(currentUrl);

        // Validate security and IP addresses on EVERY redirect hop
        await this.validateUrlSecurity(currentUrl);

        let res: Response;
        try {
          res = await fetch(currentUrl, {
            headers: options.headers,
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (fetchErr: any) {
          if (fetchErr.name === 'AbortError') {
            throw new BadRequestException(
              `Request timed out after ${this.timeoutMs}ms`,
            );
          }
          throw new BadRequestException(
            `Unable to connect to target URL: ${fetchErr.message}`,
          );
        }

        // Handle Redirects
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) {
            throw new BadRequestException(
              `HTTP ${res.status} redirect without location header`,
            );
          }

          if (hop === this.maxRedirects) {
            throw new BadRequestException(
              `Maximum allowed redirect hops (${this.maxRedirects}) exceeded`,
            );
          }

          // Resolve relative redirect
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        if (!res.ok) {
          throw new BadRequestException(
            `HTTP ${res.status}: ${res.statusText}`,
          );
        }

        // Validate Content-Type
        const rawContentType = res.headers.get('content-type') || '';
        const contentType = rawContentType.toLowerCase();
        this.validateContentType(contentType);

        // Validate Content-Length
        const contentLengthHeader = res.headers.get('content-length');
        if (contentLengthHeader) {
          const length = parseInt(contentLengthHeader, 10);
          if (length > this.maxBodySizeBytes) {
            throw new BadRequestException(
              `Response body exceeds maximum allowed size (${this.maxBodySizeBytes / (1024 * 1024)}MB)`,
            );
          }
        }

        // Bounded Body Stream Reader
        const text = await this.readBoundedResponseBody(res);
        return { text, contentType, finalUrl: currentUrl };
      }

      throw new BadRequestException('Too many redirects');
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Reads response body chunks with strict total byte boundary.
   */
  private async readBoundedResponseBody(res: Response): Promise<string> {
    if (!res.body) {
      return '';
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalBytes += value.length;
        if (totalBytes > this.maxBodySizeBytes) {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel errors
          }
          throw new BadRequestException(
            `Response stream exceeded maximum allowed size of ${this.maxBodySizeBytes / (1024 * 1024)}MB`,
          );
        }
        chunks.push(value);
      }
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return new TextDecoder('utf-8').decode(merged);
  }

  /**
   * Validates Content-Type header against whitelist of academic and web formats.
   */
  private validateContentType(contentType: string): void {
    const allowedPrefixes = [
      'text/html',
      'application/xhtml+xml',
      'application/vnd.citationstyles.csl+json',
      'application/json',
      'application/xml',
      'text/xml',
      'application/atom+xml',
      'application/rss+xml',
      'text/plain',
    ];

    const isAllowed = allowedPrefixes.some((prefix) =>
      contentType.includes(prefix),
    );

    if (!isAllowed) {
      throw new BadRequestException(
        `Unsupported content type: ${contentType || 'unknown'}. Only academic web, CSL, JSON, and XML documents are allowed.`,
      );
    }
  }

  /**
   * SSRF Protection: strictly rejects loopback, private networks, link-local, cloud metadata, and IPv4-mapped IPv6.
   */
  async validateUrlSecurity(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Invalid URL format');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Only HTTP and HTTPS URLs are permitted');
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block obvious loopback names and non-routable domains
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === '0.0.0.0'
    ) {
      throw new BadRequestException(
        'Access to localhost and local domains is forbidden',
      );
    }

    // Resolve IP addresses to prevent DNS rebinding to private networks
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (addresses.length === 0) {
        throw new BadRequestException(
          `Could not resolve IP address for hostname ${hostname}`,
        );
      }

      for (const addr of addresses) {
        if (this.isPrivateOrReservedIp(addr.address)) {
          throw new BadRequestException(
            `Access to private/internal IP address (${addr.address}) is forbidden`,
          );
        }
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.debug(
        `DNS resolution check error for ${hostname}: ${err.message}`,
      );
      throw new BadRequestException(
        `Failed to verify host safety for ${hostname}: ${err.message}`,
      );
    }
  }

  /**
   * Checks if an IPv4 or IPv6 address is in a private, loopback, link-local, or cloud metadata range.
   */
  isPrivateOrReservedIp(ip: string): boolean {
    if (!net.isIP(ip)) return false;

    // Handle IPv4-mapped IPv6 addresses: ::ffff:192.0.2.128
    if (ip.toLowerCase().startsWith('::ffff:')) {
      const extractedIpv4 = ip.slice(7);
      if (net.isIPv4(extractedIpv4)) {
        return this.isPrivateOrReservedIp(extractedIpv4);
      }
    }

    // IPv4 checks
    if (net.isIPv4(ip)) {
      const parts = ip.split('.').map((p) => parseInt(p, 10));
      // 0.0.0.0/8
      if (parts[0] === 0) return true;
      // 127.0.0.0/8 (Loopback)
      if (parts[0] === 127) return true;
      // 10.0.0.0/8 (Private)
      if (parts[0] === 10) return true;
      // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      // 192.168.0.0/16 (Private)
      if (parts[0] === 192 && parts[1] === 168) return true;
      // 169.254.0.0/16 (Link-local / Cloud Metadata 169.254.169.254)
      if (parts[0] === 169 && parts[1] === 254) return true;
      // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
      if (parts[0] >= 224) return true;
      // 255.255.255.255 (Broadcast)
      if (ip === '255.255.255.255') return true;
    }

    // IPv6 checks
    if (net.isIPv6(ip)) {
      const normalized = ip.toLowerCase();
      // Loopback & Unspecified
      if (normalized === '::1' || normalized === '::') return true;
      // fc00::/7 & fd00::/8 (Unique Local Address - ULA)
      if (normalized.startsWith('fc') || normalized.startsWith('fd'))
        return true;
      // fe80::/10 (Link-local)
      if (
        normalized.startsWith('fe80:') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb')
      )
        return true;
      // ff00::/8 (Multicast)
      if (normalized.startsWith('ff')) return true;
    }

    return false;
  }

  /**
   * Computes SHA-256 hash of opaque preview token for indexing and database lookup.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generates cryptographic HMAC preview token bound to workspace, user, URL, metadata digest, and expiration.
   */
  attachPreviewToken(
    meta: CapturedPaperMetadata,
    context?: { workspaceId?: string; userId?: string },
  ): CapturedPaperMetadata {
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

    return {
      ...meta,
      previewToken,
    };
  }

  /**
   * Computes deterministic SHA-256 digest of captured metadata fields including creators and tags.
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
    context?: {
      workspaceId?: string;
      userId?: string;
    },
  ): PreviewTokenVerificationResult {
    if (!token) {
      return { valid: false, reason: 'missing_token' };
    }

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

    // Check Token Expiration (15 minutes)
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
}
