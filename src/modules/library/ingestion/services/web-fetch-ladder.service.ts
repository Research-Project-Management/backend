import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IWebFetchPort,
  WebFetchOptions,
  WebFetchResponse,
  MirrorBibliographicMetadata,
} from '@/modules/library/ingestion/types/web-fetch.types';
import { IngestionVerifierService } from './ingestion-verifier.service';
import { SsrfGuardService } from '@/modules/library/shared-kernel/core/services/ssrf-guard.service';
import { MetadataRoutingPolicy } from '@/modules/library/ingestion/policies/metadata.policy';
import { DomainRateLimiterService } from './domain-rate-limiter.service';
import {
  deriveDoiFromPublisherUrl,
  deriveDirectPdfUrl,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  isBotChallengePage,
  cleanAbstractText,
  cleanBibliographicText,
} from '@/modules/library/shared-kernel/domain/bibliographic.domain';

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
    @Optional() private readonly rateLimiter?: DomainRateLimiterService,
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
    return SsrfGuardService.executeSafeRedirectFetch(
      startUrl,
      {
        headers: BROWSER_FETCH_HEADERS,
        signal,
      },
      {
        maxRedirects: MAX_REDIRECTS,
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
  private async resolveOpenMirror(
    doi?: string,
    pmid?: string,
    pmcid?: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    if (!doi && !pmid && !pmcid) return null;

    try {
      const rawQuery = doi
        ? `DOI:"${doi}"`
        : pmid
          ? `EXT_ID:${pmid}`
          : `PMC:${pmcid}`;
      const endpoint = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(rawQuery)}&format=json&resultType=core`;

      const signal = AbortSignal.timeout(6000);
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        signal,
      });

      if (!res.ok) {
        if (doi) return this.resolveCrossRef(doi);
        return null;
      }

      const data = await res.json();
      const record = data?.resultList?.result?.[0];
      if (!record || !record.title) {
        if (doi) return this.resolveCrossRef(doi);
        return null;
      }

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
          (u: { documentStyle?: string; url?: string }) =>
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Open mirror resolution failed for DOI "${doi}" / PMID "${pmid}": ${msg}`,
      );
      if (doi) {
        return this.resolveCrossRef(doi);
      }
      return null;
    }
  }

  /**
   * Free & Open CrossRef Works API mirror resolver (0đ, polite pool).
   * Covers 150M+ DOIs across Springer, IEEE, ACM, Nature, Wiley, bioRxiv, arXiv, etc.
   */
  private async resolveCrossRef(
    doi: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    try {
      let targetDoi = doi;
      let endpoint = `https://api.crossref.org/works/${encodeURIComponent(targetDoi)}?mailto=contact@flux.academic`;
      const signal = AbortSignal.timeout(6000);
      let res = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        signal,
      });

      // BioRxiv/MedRxiv DOIs in URLs often have version suffix (e.g. 10.1101/2020.03.22.002386v1)
      // which CrossRef indexes under base DOI without version.
      if (!res.ok && /v\d+$/i.test(targetDoi)) {
        targetDoi = targetDoi.replace(/v\d+$/i, '');
        endpoint = `https://api.crossref.org/works/${encodeURIComponent(targetDoi)}?mailto=contact@flux.academic`;
        res = await fetch(endpoint, {
          headers: { Accept: 'application/json' },
          signal,
        });
      }

      if (!res.ok) return null;

      const data = await res.json();
      const item = data?.message;
      if (!item) return null;

      const rawTitle = Array.isArray(item.title) ? item.title[0] : item.title;
      if (!rawTitle) return null;

      const authors: string[] = [];
      if (Array.isArray(item.author)) {
        for (const a of item.author) {
          if (a.name) {
            authors.push(a.name.trim());
          } else if (a.family) {
            authors.push(`${a.given ? a.given + ' ' : ''}${a.family}`.trim());
          }
        }
      }

      const year =
        item['published-print']?.['date-parts']?.[0]?.[0] ||
        item['published-online']?.['date-parts']?.[0]?.[0] ||
        item['created']?.['date-parts']?.[0]?.[0];

      const journal =
        (Array.isArray(item['container-title'])
          ? item['container-title'][0]
          : item['container-title']) || item.publisher;

      const cleanAbstract = item.abstract
        ? cleanAbstractText(item.abstract.replace(/<[^>]+>/g, ' '))
        : undefined;

      return {
        title: cleanBibliographicText(rawTitle),
        abstract: cleanAbstract,
        authors: authors.length > 0 ? authors : undefined,
        year: typeof year === 'number' ? year : undefined,
        doi: item.DOI || targetDoi,
        journal: journal ? cleanBibliographicText(journal) : undefined,
        isOpenAccess: false,
        sourceMirror: 'CrossRef',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Open mirror resolution (CrossRef) failed for DOI "${doi}": ${msg}`,
      );
      return null;
    }
  }

  /**
   * Free & Open arXiv Export API resolver (0đ, polite open mirror).
   */
  private async resolveArxiv(
    arxivId: string,
  ): Promise<MirrorBibliographicMetadata | null> {
    try {
      const cleanId = normalizeArxivId(arxivId);
      if (!cleanId) return null;
      const endpoint = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
      const signal = AbortSignal.timeout(6000);
      const res = await fetch(endpoint, { signal });
      if (!res.ok) return null;

      const xml = await res.text();
      const titleMatch = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
      const rawTitle = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
      if (!rawTitle) return null;

      const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
      const rawAbstract = summaryMatch?.[1]?.replace(/\s+/g, ' ').trim();

      const authorMatches = [
        ...xml.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g),
      ];
      const authors = authorMatches.map((m) => m[1].trim()).filter(Boolean);

      const pubYearMatch = xml.match(/<published>(\d{4})/);
      const year = pubYearMatch ? parseInt(pubYearMatch[1], 10) : undefined;

      const doiMatch = xml.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
      const doi = doiMatch ? doiMatch[1].trim() : `10.48550/arXiv.${cleanId}`;

      return {
        title: cleanBibliographicText(rawTitle),
        abstract: rawAbstract ? cleanAbstractText(rawAbstract) : undefined,
        authors: authors.length > 0 ? authors : undefined,
        year,
        doi,
        journal: 'arXiv',
        isOpenAccess: true,
        sourceMirror: 'arXiv',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `Open mirror resolution (arXiv) failed for ID "${arxivId}": ${msg}`,
      );
      return null;
    }
  }

  /**
   * Free & Open OpenAlex Works API resolver (0đ, polite pool).
   * Covers 250M+ scientific publications across all publishers, preprints, and open repositories.
   */
  private async resolveOpenAlex(target: {
    doi?: string;
    pmid?: string;
    pmcid?: string;
    url?: string;
  }): Promise<MirrorBibliographicMetadata | null> {
    try {
      let endpoint: string;
      const mailto =
        process.env.OPENALEX_EMAIL ||
        process.env.ACADEMIC_EMAIL ||
        'contact@flux.academic';

      if (target.doi) {
        endpoint = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(target.doi)}?mailto=${encodeURIComponent(mailto)}`;
      } else if (target.pmid) {
        endpoint = `https://api.openalex.org/works/pmid:${encodeURIComponent(target.pmid)}?mailto=${encodeURIComponent(mailto)}`;
      } else if (target.pmcid) {
        endpoint = `https://api.openalex.org/works/pmcid:${encodeURIComponent(target.pmcid)}?mailto=${encodeURIComponent(mailto)}`;
      } else if (target.url) {
        endpoint = `https://api.openalex.org/works?filter=locations.landing_page_url:${encodeURIComponent(target.url)}&mailto=${encodeURIComponent(mailto)}`;
      } else {
        return null;
      }

      const signal = AbortSignal.timeout(6000);
      const res = await fetch(endpoint, {
        headers: {
          Accept: 'application/json',
          'User-Agent': `FluxResearchPlatform/1.0 (mailto:${mailto})`,
        },
        signal,
      });

      if (!res.ok) return null;
      const data = await res.json();
      const item = Array.isArray(data.results) ? data.results[0] : data;
      if (!item || (!item.title && !item.display_name)) return null;

      const rawTitle = item.title || item.display_name;
      const authors: string[] = [];
      if (Array.isArray(item.authorships)) {
        for (const auth of item.authorships) {
          if (auth?.author?.display_name) {
            authors.push(auth.author.display_name.trim());
          }
        }
      }

      const primLoc = item.primary_location;
      const journal =
        primLoc?.source?.display_name || item.host_venue?.display_name;
      const pdfUrl = item.open_access?.oa_url || primLoc?.pdf_url;

      let abstract: string | undefined;
      if (
        item.abstract_inverted_index &&
        typeof item.abstract_inverted_index === 'object'
      ) {
        const wordPositions: Array<{ word: string; pos: number }> = [];
        for (const [word, positions] of Object.entries(
          item.abstract_inverted_index as Record<string, number[]>,
        )) {
          if (Array.isArray(positions)) {
            for (const pos of positions) {
              wordPositions.push({ word, pos });
            }
          }
        }
        wordPositions.sort((a, b) => a.pos - b.pos);
        abstract = wordPositions
          .map((wp) => wp.word)
          .join(' ')
          .trim();
      }

      return {
        title: cleanBibliographicText(rawTitle),
        abstract: abstract ? cleanAbstractText(abstract) : undefined,
        authors: authors.length > 0 ? authors : undefined,
        year:
          typeof item.publication_year === 'number'
            ? item.publication_year
            : undefined,
        doi: normalizeDoi(item.doi) || target.doi,
        journal: journal ? cleanBibliographicText(journal) : undefined,
        isOpenAccess: Boolean(item.open_access?.is_oa),
        pdfUrl: pdfUrl || undefined,
        sourceMirror: 'OpenAlex',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`OpenAlex mirror resolution failed: ${msg}`);
      return null;
    }
  }

  /**
   * Ladder Step 3: External Stealth Proxy / Headless Fetcher fallback.
   * Leverages optional containerized stealth scraper (FlareSolverr / Browserless / headless microservice).
   */
  private async executeStealthFetch(
    url: string,
  ): Promise<{ text?: string; status: number } | null> {
    const stealthEndpoint =
      process.env.STEALTH_SCRAPER_URL ||
      process.env.HEADLESS_SCRAPER_URL ||
      process.env.FLARESOLVERR_URL;

    if (!stealthEndpoint) {
      return null;
    }

    try {
      const signal = AbortSignal.timeout(15000);
      const isFlareSolverr =
        stealthEndpoint.toLowerCase().includes('flaresolverr') ||
        stealthEndpoint.endsWith('/v1');

      if (isFlareSolverr) {
        const res = await fetch(stealthEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cmd: 'request.get',
            url,
            maxTimeout: 14000,
          }),
          signal,
        });

        if (!res.ok) return null;
        const json = await res.json();
        if (json?.status === 'ok' && json?.solution?.response) {
          return {
            text: json.solution.response,
            status: json.solution.status || 200,
          };
        }
      } else {
        const res = await fetch(stealthEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/html,application/json',
          },
          body: JSON.stringify({ url }),
          signal,
        });

        if (!res.ok) return null;
        const contentType = (
          res.headers.get('content-type') || ''
        ).toLowerCase();
        if (contentType.includes('application/json')) {
          const json = await res.json();
          const text = json.html || json.body || json.text || json.content;
          if (text) {
            return { text, status: json.status || res.status };
          }
        } else {
          const text = await res.text();
          return { text, status: res.status };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Stealth fetch attempt failed for "${url}": ${msg}`);
    }

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
      } catch (err: unknown) {
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
          const bodyText = await fetchRes.text();
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

    // ── Ladder Step 2: Open Mirror Resolver (0đ) ──────────────────────────────
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
