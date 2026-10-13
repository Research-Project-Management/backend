import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import {
  IWebFetchPort,
  WebFetchOptions,
  WebFetchResponse,
  MirrorBibliographicMetadata,
} from '../types/web-fetch.types';
import { IngestionVerifierService } from './ingestion-verifier.service';
import { SsrfGuardService } from '../../shared-kernel/core/services/ssrf-guard.service';
import { MetadataRoutingPolicy } from '../policies/metadata.policy';
import {
  deriveDoiFromPublisherUrl,
  deriveDirectPdfUrl,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  isBotChallengePage,
  cleanAbstractText,
} from '../../shared-kernel/utils/bibliographic.utils';

const DEFAULT_FETCH_TIMEOUT_MS = 14000;
const MAX_REDIRECTS = 5;

const BROWSER_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (Academic Client; mailto:contact@flux.academic)',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Thrown when a redirect hop targets an unsafe destination. */
class UnsafeRedirectError extends Error {}

/**
 * Enterprise Web Retrieval Ladder Service.
 * Implements the 5-step fallback ladder designed in ingestion_pipeline_design.md:
 * - Ladder 0: Offline Identifier Derivation (0đ, 0ms, no network)
 * - Ladder 1: Direct Plain HTTP Fetch with realistic browser headers & SSRF protection (0đ)
 * - Ladder 2: Open Academic Mirror Resolver (EuropePMC / arXiv Open API, 0đ)
 * - Ladder 3: External Stealth Proxy / Headless Fetcher (conditional, quota-guarded)
 * - Ladder 4: Graceful BLOCKED State with prompt for user PDF upload (0đ)
 */
@Injectable()
export class WebFetchLadderService implements IWebFetchPort {
  private readonly logger = new Logger(WebFetchLadderService.name);

  constructor(
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional() private readonly verifier?: IngestionVerifierService,
  ) {}

  private async assertSafeUrl(url: string): Promise<void> {
    if (this.ssrfGuard) {
      await this.ssrfGuard.assertSafeUrl(url);
    } else {
      MetadataRoutingPolicy.validateUrl(url);
    }
  }

  /**
   * Executes multi-hop safe redirects with SSRF validation on every step.
   */
  private async fetchWithSafeRedirects(
    startUrl: string,
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  ): Promise<{ response: Response; finalUrl: string }> {
    const signal = AbortSignal.timeout(timeoutMs);
    let currentUrl = startUrl;

    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const res = await fetch(currentUrl, {
        headers: BROWSER_FETCH_HEADERS,
        signal,
        redirect: 'manual',
      });

      const status = res.status;
      const location =
        typeof status === 'number' && status >= 300 && status < 400
          ? res.headers?.get?.('location')
          : null;

      if (!location) {
        return { response: res, finalUrl: currentUrl };
      }

      try {
        await res.body?.cancel();
      } catch {
        /* ignore cancel error */
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new UnsafeRedirectError(`Invalid redirect target "${location}"`);
      }

      if (!/^https?:$/i.test(new URL(nextUrl).protocol)) {
        throw new UnsafeRedirectError(
          `Redirect to non-HTTP scheme rejected: "${nextUrl}"`,
        );
      }

      await this.assertSafeUrl(nextUrl);
      currentUrl = nextUrl;
    }

    throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
  }

  /**
   * Ladder Step 0: Extract identifiers directly from URL structure (0đ, 0ms, offline).
   */
  private deriveIdentifiers(url: string): {
    doi?: string;
    arxivId?: string;
    pmid?: string;
  } {
    const doiFromPublisher = deriveDoiFromPublisherUrl(url);
    const cleanDoi = doiFromPublisher ? normalizeDoi(doiFromPublisher) : undefined;

    let arxivId: string | undefined;
    const arxivMatch = url.match(
      /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:)([\d.]+v?\d*)/i,
    );
    if (arxivMatch) {
      arxivId = normalizeArxivId(arxivMatch[1]);
    }

    let pmid: string | undefined;
    const pmidMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
    if (pmidMatch) {
      pmid = normalizePmid(pmidMatch[1]);
    }

    return {
      doi: cleanDoi,
      arxivId,
      pmid,
    };
  }

  /**
   * Ladder Step 2: Query EuropePMC public open API to resolve metadata without WAF interference.
   */
  private async resolveOpenMirror(
    doi?: string,
    pmid?: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    if (!doi && !pmid) return null;

    try {
      const query = doi
        ? `DOI:"${encodeURIComponent(doi)}"`
        : `EXT_ID:"${encodeURIComponent(pmid!)}" AND SRC:MED`;
      const endpoint = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${query}&format=json&resultType=core`;

      const signal = AbortSignal.timeout(6000);
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        signal,
      });

      if (!res.ok) return null;

      const data = (await res.json()) as any;
      const record = data?.resultList?.result?.[0];
      if (!record || !record.title) return null;

      const authors: string[] = [];
      if (Array.isArray(record.authorList?.author)) {
        for (const a of record.authorList.author) {
          if (a.fullName) authors.push(a.fullName.trim());
          else if (a.lastName) {
            authors.push(
              `${a.firstName ? a.firstName + ' ' : ''}${a.lastName}`.trim(),
            );
          }
        }
      } else if (record.authorString) {
        authors.push(
          ...record.authorString
            .split(/,\s*(?:and\s+)?/)
            .map((s: string) => s.trim())
            .filter(Boolean),
        );
      }

      let pdfUrl: string | undefined;
      if (Array.isArray(record.fullTextUrlList?.fullTextUrl)) {
        const pdfEntry = record.fullTextUrlList.fullTextUrl.find(
          (u: any) =>
            u.documentStyle === 'pdf' ||
            (typeof u.url === 'string' && u.url.toLowerCase().endsWith('.pdf')),
        );
        if (pdfEntry?.url) {
          pdfUrl = pdfEntry.url;
        }
      }

      const cleanAbstract = record.abstractText
        ? cleanAbstractText(record.abstractText.replace(/<[^>]+>/g, ' '))
        : undefined;

      return {
        title: record.title.replace(/<[^>]+>/g, '').trim(),
        abstract: cleanAbstract,
        authors: authors.length > 0 ? authors : undefined,
        year: record.pubYear ? parseInt(record.pubYear, 10) : undefined,
        doi: record.doi || doi,
        pmid: record.pmid || pmid,
        pmcid: record.pmcid,
        journal:
          record.journalTitle ||
          record.journalInfo?.journal?.title ||
          record.bookOrReportDetails?.publisher,
        isOpenAccess: record.isOpenAccess === 'Y',
        pdfUrl,
        sourceMirror: 'EuropePMC',
      };
    } catch (err: any) {
      this.logger.debug(
        `Open mirror resolution failed for DOI "${doi}" / PMID "${pmid}": ${err?.message}`,
      );
      return null;
    }
  }

  /**
   * Ladder Step 3: External Stealth Proxy / Headless Fetcher fallback.
   */
  private async executeStealthFetch(
    _url: string,
  ): Promise<{ text?: string; status: number } | null> {
    // External commercial scraping proxies (Tavily) removed to eliminate recurring costs.
    return null;
  }

  /**
   * Primary entry point: Executes the Web Retrieval Ladder.
   */
  async fetch(
    url: string,
    options?: WebFetchOptions,
  ): Promise<WebFetchResponse> {
    const canonicalUrl = url.trim();
    const warnings: string[] = [];

    // ── Ladder Step 0: Identifier Derivation (0đ, 0ms) ────────────────────────
    const derivedIdentifier = this.deriveIdentifiers(canonicalUrl);

    try {
      await this.assertSafeUrl(canonicalUrl);
    } catch (ssrfErr: any) {
      this.logger.warn(
        `SSRF security block for URL "${canonicalUrl}": ${ssrfErr?.message}`,
      );
      return {
        url: canonicalUrl,
        finalUrl: canonicalUrl,
        status: 400,
        isBlocked: false,
        isPdf: false,
        ladderStepReached: 0,
        derivedIdentifier,
        warnings: [`SSRF rejected: ${ssrfErr?.message}`],
      };
    }

    // ── Ladder Step 1: Direct Plain HTTP Fetch (0đ) ───────────────────────────
    const directPdfUrl = deriveDirectPdfUrl(canonicalUrl);
    const urlsToTry =
      directPdfUrl && directPdfUrl !== canonicalUrl
        ? [directPdfUrl, canonicalUrl]
        : [canonicalUrl];

    let fetchRes: Response | undefined;
    let finalUrl = canonicalUrl;
    let fetchError: Error | undefined;

    for (const targetUrl of urlsToTry) {
      try {
        const fetched = await this.fetchWithSafeRedirects(
          targetUrl,
          options?.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS,
        );
        fetchRes = fetched.response;
        finalUrl = fetched.finalUrl;
        if (fetchRes.ok || fetchRes.status === 403 || fetchRes.status === 429) {
          break;
        }
      } catch (err: any) {
        fetchError = err;
        this.logger.debug(
          `Plain HTTP fetch error for "${targetUrl}": ${err?.message}`,
        );
      }
    }

    // If HTTP fetch succeeded, analyze response
    if (fetchRes) {
      const status = fetchRes.status;
      const contentType = (
        fetchRes.headers?.get?.('content-type') || ''
      ).toLowerCase();

      // Check if blocked by status (403, 429)
      const statusBlocked =
        this.verifier?.detectBlockedStatus(finalUrl, undefined, status) || {
          isBlocked: status === 403 || status === 429,
          wafKind: status === 403 ? 'HTTP_403_FORBIDDEN' : status === 429 ? 'RATE_LIMITED' : undefined,
          promptUploadPdf: status === 403 || status === 429,
        };

      if (!statusBlocked.isBlocked && fetchRes.ok) {
        // Check for direct PDF response
        const isPdfHeader =
          contentType.includes('application/pdf') ||
          canonicalUrl.toLowerCase().endsWith('.pdf') ||
          new URL(canonicalUrl).pathname.toLowerCase().endsWith('.pdf') ||
          new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf');

        if (isPdfHeader) {
          try {
            const arrayBuf = await fetchRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);
            const isPdfMagic =
              buffer.length >= 4 &&
              buffer[0] === 0x25 &&
              buffer[1] === 0x50 &&
              buffer[2] === 0x44 &&
              buffer[3] === 0x46;

            if (isPdfMagic) {
              return {
                url: canonicalUrl,
                finalUrl,
                status: 200,
                isBlocked: false,
                isPdf: true,
                bodyBuffer: buffer,
                contentType,
                ladderStepReached: 1,
                derivedIdentifier,
              };
            }
          } catch (bufferErr: any) {
            warnings.push(`PDF stream read failed: ${bufferErr?.message}`);
          }
        }

        // HTML Response
        try {
          const bodyText = await fetchRes.text();
          const htmlBlocked =
            this.verifier?.detectBlockedStatus(finalUrl, bodyText, status) || {
              isBlocked: isBotChallengePage(bodyText),
              wafKind: 'BOT_CHALLENGE',
              promptUploadPdf: true,
            };

          if (!htmlBlocked.isBlocked && !isBotChallengePage(bodyText)) {
            // Step 1 Success! Clean HTML returned
            return {
              url: canonicalUrl,
              finalUrl,
              status: 200,
              isBlocked: false,
              isPdf: false,
              bodyText,
              contentType,
              ladderStepReached: 1,
              derivedIdentifier,
            };
          }

          this.logger.warn(
            `[Ladder Step 1] Bot challenge detected for "${canonicalUrl}". Escalating to Ladder Step 2...`,
          );
        } catch (textErr: any) {
          warnings.push(`HTML text read failed: ${textErr?.message}`);
        }
      }
    }

    // ── Ladder Step 2: Open Mirror Resolver (0đ) ──────────────────────────────
    const targetDoi = derivedIdentifier.doi;
    const targetPmid = derivedIdentifier.pmid;

    if (targetDoi || targetPmid) {
      this.logger.log(
        `[Ladder Step 2] Querying Open Mirror (EuropePMC) for DOI="${targetDoi}" / PMID="${targetPmid}"...`,
      );
      const mirrorMetadata = await this.resolveOpenMirror(
        targetDoi,
        targetPmid,
      );

      if (mirrorMetadata) {
        this.logger.log(
          `[Ladder Step 2] Successfully resolved metadata via EuropePMC mirror! Title: "${mirrorMetadata.title}"`,
        );
        return {
          url: canonicalUrl,
          finalUrl,
          status: 200,
          isBlocked: false,
          isPdf: false,
          ladderStepReached: 2,
          derivedIdentifier,
          mirrorMetadata,
          warnings,
        };
      }
    }

    // ── Ladder Step 3: Stealth / External Proxy Fetcher ───────────────────────
    if (!options?.skipStealth) {
      this.logger.log(
        `[Ladder Step 3] Attempting stealth proxy fetch for "${canonicalUrl}"...`,
      );
      const stealthRes = await this.executeStealthFetch(canonicalUrl);
      if (stealthRes?.text) {
        this.logger.log(
          `[Ladder Step 3] Stealth fetch succeeded for "${canonicalUrl}".`,
        );
        return {
          url: canonicalUrl,
          finalUrl,
          status: stealthRes.status,
          isBlocked: false,
          isPdf: false,
          bodyText: stealthRes.text,
          ladderStepReached: 3,
          derivedIdentifier,
          warnings,
        };
      }
    }

    // ── Ladder Step 4: Graceful BLOCKED State ─────────────────────────────────
    this.logger.warn(
      `[Ladder Step 4] All retrieval ladders exhausted for "${canonicalUrl}". Flagging as BLOCKED.`,
    );
    const lastStatus = fetchRes?.status || (fetchError ? 502 : 403);
    const wafKind =
      lastStatus === 403
        ? 'HTTP_403_FORBIDDEN'
        : lastStatus === 429
          ? 'RATE_LIMITED'
          : 'CLOUDFLARE_TURNSTILE';

    return {
      url: canonicalUrl,
      finalUrl,
      status: lastStatus,
      isBlocked: true,
      wafKind,
      promptUploadPdf: true,
      isPdf: false,
      ladderStepReached: 4,
      derivedIdentifier,
      warnings: [
        ...warnings,
        'Site is protected by anti-bot WAF / Cloudflare Turnstile. Direct PDF upload required.',
      ],
    };
  }
}
