import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  IWebFetchPort,
  WebFetchOptions,
  WebFetchResponse,
  MirrorBibliographicMetadata,
} from '@/modules/library/ingestion/types/metadata.types';
import { IngestionVerifierService } from './ingestion-verifier.service';
import {
  SsrfGuardService,
  DEFAULT_BROWSER_FETCH_HEADERS,
  DEFAULT_SAFE_REDIRECT_MAX_HOPS,
} from '@/modules/library/core/services/ssrf-guard.service';
import {
  MetadataRoutingPolicy,
  SsrfBlockedDomainException,
} from '@/modules/library/ingestion/domain/metadata.policy';
import { DomainRateLimiterService } from './feed-retrieval.service';
import {
  deriveDoiFromPublisherUrl,
  deriveDirectPdfUrl,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  isBotChallengePage,
  HttpClient,
  LibraryConfigService,
  readSafeResponseBuffer,
  readSafeResponseText,
} from '@/modules/library/core';

import { WebMirrorResolverService } from './web-mirror-resolver.service';
import { CrossRefProvider } from '@/modules/library/ingestion/providers/crossref.provider';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import { OpenAlexProvider } from '@/modules/library/ingestion/providers/openalex.provider';

export { WebMirrorResolverService };

const DEFAULT_FETCH_TIMEOUT_MS = 14000;

/**
 * Web Retrieval Ladder Service.
 * Implements the fallback ladder:
 * - Ladder 0: Offline Identifier Derivation (0ms, no network)
 * - Ladder 1: Direct Plain HTTP Fetch with realistic browser headers & SSRF protection
 * - Ladder 2: Open Bibliographic Mirror Resolver (EuropePMC / CrossRef / arXiv / OpenAlex)
 * - Ladder 4: Graceful BLOCKED State with prompt for user PDF upload
 */
@Injectable()
export class WebFetchLadderService implements IWebFetchPort {
  private readonly logger = new Logger(WebFetchLadderService.name);

  private readonly mirrorResolver: WebMirrorResolverService;

  constructor(
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional() private readonly verifier?: IngestionVerifierService,
    @Optional() private readonly rateLimiter?: DomainRateLimiterService,
    @Optional() private readonly httpClient?: HttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
    @Optional() mirrorResolver?: WebMirrorResolverService,
    @Optional() private readonly crossRefProvider?: CrossRefProvider,
    @Optional() private readonly arxivProvider?: ArxivProvider,
    @Optional() private readonly openAlexProvider?: OpenAlexProvider,
  ) {
    this.mirrorResolver =
      mirrorResolver ??
      new WebMirrorResolverService(
        this.httpClient,
        this.crossRefProvider,
        this.arxivProvider,
        this.openAlexProvider,
      );
  }

  private isSsrfError(err: unknown): boolean {
    if (
      err instanceof BadRequestException ||
      err instanceof ForbiddenException ||
      err instanceof SsrfBlockedDomainException
    ) {
      return true;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('SSRF Protection') || msg.includes('SSRF');
  }

  private async assertSafeUrl(url: string): Promise<void> {
    if (this.ssrfGuard) {
      await this.ssrfGuard.assertSafeUrl(url);
    } else {
      await MetadataRoutingPolicy.assertSafeUrl(url);
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
    return SsrfGuardService.executeSafeRedirectFetch(
      startUrl,
      {
        headers: DEFAULT_BROWSER_FETCH_HEADERS,
        signal,
      },
      {
        maxRedirects: DEFAULT_SAFE_REDIRECT_MAX_HOPS,
        validateUrl: (nextUrl) => this.assertSafeUrl(nextUrl),
        beforeHop: async (currentUrl, hopSignal) => {
          if (this.rateLimiter) {
            try {
              const hostname = new URL(currentUrl).hostname;
              await this.rateLimiter.acquire(hostname, hopSignal ?? undefined);
            } catch {
              // If aborted or non-fatal rate limiting error
            }
          }
        },
      },
    );
  }

  /**
   * Ladder Step 0: Extract identifiers directly from URL structure (0đ, 0ms, offline).
   */
  private deriveIdentifiers(url: string): {
    doi?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
  } {
    const doiFromPublisher = deriveDoiFromPublisherUrl(url);
    const cleanDoi = doiFromPublisher
      ? normalizeDoi(doiFromPublisher)
      : undefined;

    let arxivId: string | undefined;
    const arxivMatch = url.match(
      /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:)([\d.]+v?\d*)/i,
    );
    if (arxivMatch) {
      arxivId = normalizeArxivId(arxivMatch[1]);
    }

    let pmid: string | undefined;
    const pmidMatch = url.match(
      /(?:pubmed\.ncbi\.nlm\.nih\.gov\/|europepmc\.org\/article\/MED\/)(\d+)/i,
    );
    if (pmidMatch) {
      pmid = normalizePmid(pmidMatch[1]);
    }

    let pmcid: string | undefined;
    const pmcMatch = url.match(
      /(?:ncbi\.nlm\.nih\.gov\/pmc\/articles\/|europepmc\.org\/article\/PMC\/)(PMC\d+)/i,
    );
    if (pmcMatch) {
      pmcid = normalizePmcid(pmcMatch[1]);
    }

    return {
      doi: cleanDoi,
      arxivId,
      pmid,
      pmcid,
    };
  }

  /**
   * Ladder Step 2: Query EuropePMC public open API to resolve metadata without WAF interference.
   */
  async resolveOpenMirror(
    doi?: string,
    pmid?: string,
    pmcid?: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    return (
      (await this.mirrorResolver?.resolveOpenMirror(doi, pmid, pmcid)) ?? null
    );
  }

  /**
   * Free & Open CrossRef Works API mirror resolver (0đ, polite pool).
   */
  async resolveCrossRef(
    doi: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    return (await this.mirrorResolver?.resolveCrossRef(doi)) ?? null;
  }

  /**
   * Free & Open arXiv Export API resolver (0đ, polite open mirror).
   */
  async resolveArxiv(
    arxivId: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    return (await this.mirrorResolver?.resolveArxiv(arxivId)) ?? null;
  }

  /**
   * Free & Open OpenAlex Works API resolver (0đ, polite pool).
   */
  async resolveOpenAlex(target: {
    doi?: string;
    pmid?: string;
    pmcid?: string;
    url?: string;
  }): Promise<MirrorBibliographicMetadata | null> {
    return (await this.mirrorResolver?.resolveOpenAlex(target)) ?? null;
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

    // Ladder Step 0: Identifier Derivation (0đ, 0ms)
    const derivedIdentifier = this.deriveIdentifiers(canonicalUrl);

    try {
      await this.assertSafeUrl(canonicalUrl);
    } catch (ssrfErr: unknown) {
      const ssrfMsg =
        ssrfErr instanceof Error ? ssrfErr.message : String(ssrfErr);
      this.logger.warn(
        `SSRF security block for URL "${canonicalUrl}": ${ssrfMsg}`,
      );
      return {
        url: canonicalUrl,
        finalUrl: canonicalUrl,
        status: 400,
        isBlocked: false,
        isPdf: false,
        ladderStepReached: 0,
        derivedIdentifier,
        warnings: [`SSRF rejected: ${ssrfMsg}`],
      };
    }

    // Ladder Step 1: Direct Plain HTTP Fetch (0đ)
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
      } catch (err: unknown) {
        if (this.isSsrfError(err)) {
          const ssrfMsg = err instanceof Error ? err.message : String(err);
          return {
            url: canonicalUrl,
            finalUrl: targetUrl,
            status: 403,
            isBlocked: true,
            wafKind: 'SSRF_BLOCKED',
            isPdf: false,
            ladderStepReached: 1,
            derivedIdentifier,
            warnings: ['SSRF blocked redirect: ' + ssrfMsg],
          };
        }
        fetchError = err instanceof Error ? err : new Error(String(err));
        this.logger.debug(
          `Plain HTTP fetch error for "${targetUrl}": ${fetchError.message}`,
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
      const statusBlocked = this.verifier?.detectBlockedStatus(
        finalUrl,
        undefined,
        status,
      ) || {
        isBlocked: status === 403 || status === 429,
        wafKind:
          status === 403
            ? 'HTTP_403_FORBIDDEN'
            : status === 429
              ? 'RATE_LIMITED'
              : undefined,
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
            const buffer = await readSafeResponseBuffer(fetchRes);
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
          } catch (bufferErr: unknown) {
            const bufferMsg =
              bufferErr instanceof Error
                ? bufferErr.message
                : String(bufferErr);
            warnings.push(`PDF stream read failed: ${bufferMsg}`);
          }
        }

        // HTML Response
        try {
          const bodyText = await readSafeResponseText(fetchRes);
          const htmlBlocked = this.verifier?.detectBlockedStatus(
            finalUrl,
            bodyText,
            status,
          ) || {
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
        } catch (textErr: unknown) {
          const textMsg =
            textErr instanceof Error ? textErr.message : String(textErr);
          warnings.push(`HTML text read failed: ${textMsg}`);
        }
      }
    }

    // Ladder Step 2: Open Mirror Resolver (0đ)
    const targetDoi = derivedIdentifier.doi;
    const targetPmid = derivedIdentifier.pmid;
    const targetPmcid = derivedIdentifier.pmcid;
    const targetArxivId = derivedIdentifier.arxivId;

    if (
      targetDoi ||
      targetPmid ||
      targetPmcid ||
      targetArxivId ||
      canonicalUrl
    ) {
      this.logger.log(
        `[Ladder Step 2] Querying Open Mirror for DOI="${targetDoi}" / PMID="${targetPmid}" / PMCID="${targetPmcid}" / arXiv="${targetArxivId}"...`,
      );

      let mirrorMetadata: MirrorBibliographicMetadata | null = null;
      if (targetArxivId) {
        mirrorMetadata = await this.resolveArxiv(targetArxivId);
      }
      if (!mirrorMetadata && (targetDoi || targetPmid || targetPmcid)) {
        mirrorMetadata = await this.resolveOpenMirror(
          targetDoi,
          targetPmid,
          targetPmcid,
        );
      }
      if (!mirrorMetadata) {
        mirrorMetadata = await this.resolveOpenAlex({
          doi: targetDoi,
          pmid: targetPmid,
          pmcid: targetPmcid,
          url: canonicalUrl,
        });
      }

      if (mirrorMetadata) {
        this.logger.log(
          `[Ladder Step 2] Successfully resolved metadata via ${mirrorMetadata.sourceMirror || 'Open Mirror'}! Title: "${mirrorMetadata.title}"`,
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

    // Ladder Step 4: Graceful BLOCKED State
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
