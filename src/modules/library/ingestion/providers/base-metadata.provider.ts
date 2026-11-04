import { Logger, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { ItemMetadata, MetadataProvider, MetadataRequest, Provenance, ProviderCapability, ProviderName, ProviderResult, QueryType } from '@/modules/library/ingestion/types/metadata.types';
import { HttpClient, TITLE_MATCH_THRESHOLD, titleSimilarity, extractNormalizedAuthorSurnames, normalizeDoi, normalizePmid, getContactEmail, getUserAgent } from '@/modules/library/core';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';
import { RetractionDetails, RetractionLookupResult } from '@/modules/library/ingestion/types/ingestion.types';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';

export type ProviderQueryInput =
  QueryType | MetadataRequest | { type?: QueryType; queryType?: QueryType };

export interface BuildProviderResultParams {
  provider?: ProviderName;
  identifier?: string;
  metadata: Partial<ItemMetadata>;
  rawPayload: unknown;
  confidenceScore: number;
  retrievalMethod?: 'api' | 'scrape' | 'dump';
  sourceUrl?: string;
  canonicalId?: string;
  isOpenAccess?: boolean;
  openAccessPdfUrl?: string;
}

export function computeRawSnapshotHash(rawPayload: unknown): string {
  const serialized =
    typeof rawPayload === 'string'
      ? rawPayload
      : JSON.stringify(rawPayload ?? {});
  return createHash('md5').update(serialized).digest('hex');
}

export function buildProviderResult(
  params: BuildProviderResultParams & { provider: ProviderName },
): ProviderResult {
  const {
    provider,
    identifier,
    metadata,
    rawPayload,
    confidenceScore,
    sourceUrl,
    canonicalId,
    isOpenAccess,
    openAccessPdfUrl,
  } = params;

  const resolvedAt = new Date().toISOString();
  const rawSnapshotHash = computeRawSnapshotHash(rawPayload);
  const effectiveIdentifier =
    identifier ||
    metadata.doi ||
    metadata.arxivId ||
    metadata.pmid ||
    metadata.isbn ||
    metadata.title ||
    provider.toLowerCase();
  const effectiveCanonicalUrl = sourceUrl ?? metadata.url ?? undefined;
  const effectiveOpenAccessUrl =
    openAccessPdfUrl ?? metadata.openAccessPdfUrl ?? undefined;
  const effectiveIsOpenAccess = isOpenAccess ?? Boolean(effectiveOpenAccessUrl);

  const provenance: Provenance = {
    ...(metadata.provenance ?? {}),
    provider,
    originProvider: provider,
    resolvedAt,
    canonicalId:
      canonicalId ??
      (metadata.provenance as { canonicalId?: string } | undefined)
        ?.canonicalId ??
      `${provider.toLowerCase()}:${effectiveIdentifier}`,
    ...(effectiveCanonicalUrl ? { canonicalUrl: effectiveCanonicalUrl } : {}),
    confidenceScore,
    rawSnapshotHash,
    isOpenAccess: effectiveIsOpenAccess,
    ...(effectiveOpenAccessUrl
      ? { openAccessPdfUrl: effectiveOpenAccessUrl }
      : {}),
  };

  return {
    provider,
    confidence: confidenceScore,
    identifier: effectiveIdentifier,
    fetchedAt: resolvedAt,
    rawVersion: rawSnapshotHash,
    metadata: {
      ...metadata,
      provenance,
    },
  };
}

export interface TitleCandidateRankingOptions<T> {
  authorHint?: string;
  yearHint?: number | string;
  getAuthors?: (item: T) => unknown;
  getYear?: (item: T) => number | string | null | undefined;
}

export function rankBestTitleCandidate<T>(
  candidates: T[],
  queryTitle: string,
  getTitle: (item: T) => string | undefined,
  threshold: number = TITLE_MATCH_THRESHOLD,
  options?: TitleCandidateRankingOptions<T>,
): { bestMatch: T | null; bestScore: number } {
  const cleanQuery = queryTitle.trim();
  if (!cleanQuery || !Array.isArray(candidates) || candidates.length === 0) {
    return { bestMatch: null, bestScore: 0 };
  }

  const rawAuthorHint =
    typeof options?.authorHint === 'string' ? options.authorHint.trim() : '';
  const querySurnames = rawAuthorHint
    ? extractNormalizedAuthorSurnames(
        rawAuthorHint
          .split(/[;|]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : new Set<string>();

  const parsedYearHint =
    options?.yearHint !== undefined && options?.yearHint !== null
      ? Number(options.yearHint)
      : NaN;
  const hasYearHint =
    Number.isFinite(parsedYearHint) &&
    parsedYearHint >= 1000 &&
    parsedYearHint <= 2999;

  let bestCandidate: T | null = null;
  let bestCompositeScore = 0;
  let bestRawScore = 0;

  for (const candidate of candidates) {
    const candidateTitle = getTitle(candidate) ?? '';
    if (!candidateTitle) continue;
    const rawScore = titleSimilarity(cleanQuery, candidateTitle);
    if (rawScore > bestRawScore) {
      bestRawScore = rawScore;
    }
    if (rawScore < threshold) continue;

    let hasSharedAuthor = false;
    if (querySurnames.size > 0 && options?.getAuthors) {
      const candSurnames = extractNormalizedAuthorSurnames(
        options.getAuthors(candidate),
      );
      if (candSurnames.size > 0) {
        hasSharedAuthor = [...querySurnames].some((s) => candSurnames.has(s));
        if (!hasSharedAuthor) {
          const candYear = options?.getYear
            ? Number(options.getYear(candidate))
            : NaN;
          const yearCompatible =
            hasYearHint &&
            Number.isFinite(candYear) &&
            candYear >= 1000 &&
            Math.abs(parsedYearHint - candYear) <= 1;
          if (!(rawScore >= 0.92 && yearCompatible)) {
            continue;
          }
        }
      }
    }

    let yearBonus = 0;
    if (hasYearHint && options?.getYear) {
      const candYear = Number(options.getYear(candidate));
      if (Number.isFinite(candYear) && candYear >= 1000) {
        const yearDiff = Math.abs(parsedYearHint - candYear);
        if (yearDiff > 2 && !hasSharedAuthor && rawScore < 0.92) {
          continue;
        }
        yearBonus = yearDiff === 0 ? 0.04 : yearDiff === 1 ? 0.02 : -0.03;
      }
    }

    const authorBonus = hasSharedAuthor ? 0.08 : 0;
    const compositeScore = rawScore + authorBonus + yearBonus;
    if (compositeScore > bestCompositeScore) {
      bestCompositeScore = compositeScore;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    return { bestMatch: null, bestScore: bestRawScore };
  }

  return {
    bestMatch: bestCandidate,
    bestScore: Math.min(1, bestCompositeScore),
  };
}

/**
 * GoF Template Method Pattern — `BaseMetadataProvider`
 *
 * Consolidates shared HTTP transport, HTTP 429/5xx `Retry-After` error propagation
 * for `CircuitBreaker` awareness, title candidate similarity ranking, and deterministic
 * `ProviderResult` construction with MD5 `rawSnapshotHash` and `provenance`.
 */
export abstract class BaseMetadataProvider implements MetadataProvider {
  abstract readonly id: ProviderName;
  abstract readonly capabilities: ProviderCapability;

  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly httpClient?: HttpClient) {}

  protected get supportedTypes(): QueryType[] {
    return this.capabilities.queryTypes;
  }

  supports(input: ProviderQueryInput): boolean {
    if (typeof input === 'string') {
      return this.supportedTypes.includes(input);
    }
    const type = input?.queryType ?? (input as { type?: QueryType })?.type;
    return type ? this.supportedTypes.includes(type) : false;
  }

  abstract resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null>;

  protected async executeHttpFetch(
    url: string,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<Response> {
    if (this.httpClient) {
      const { response } = await this.httpClient.request(url, {
        headers,
        signal,
      });
      return response;
    }
    return fetch(url, { headers, signal });
  }

  protected parseRetryAfterHeader(
    responseOrHeader: Response | string | null | undefined,
  ): number | undefined {
    const rawHeader =
      typeof responseOrHeader === 'string'
        ? responseOrHeader
        : responseOrHeader &&
            typeof responseOrHeader.headers?.get === 'function'
          ? responseOrHeader.headers.get('retry-after')
          : undefined;
    if (!rawHeader) return undefined;
    const trimmed = rawHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = parseInt(trimmed, 10);
      if (!Number.isNaN(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }
    return undefined;
  }

  protected async fetchJsonWithResilience<T = Record<string, unknown>>(
    url: string,
    signal?: AbortSignal,
    headers?: Record<string, string>,
    options?: {
      contextLabel?: string;
      swallowNetworkError?: boolean;
    },
  ): Promise<T | null> {
    let response: Response;
    try {
      response = await this.executeHttpFetch(url, signal, headers);
    } catch (err: unknown) {
      if (options?.swallowNetworkError) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `${this.id} fetch failed non-fatally (${options.contextLabel ?? url}): ${msg}`,
        );
        return null;
      }
      throw err;
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `${this.id} API HTTP ${response.status} for ${options?.contextLabel ?? url}`,
        response.status,
        retryAfterMs,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ProviderFetchError(
        `Failed to parse ${this.id} JSON for ${options?.contextLabel ?? url}`,
        undefined,
        undefined,
        false,
        true,
      );
    }
  }

  protected async fetchTextWithResilience(
    url: string,
    signal?: AbortSignal,
    headers?: Record<string, string>,
    contextLabel?: string,
  ): Promise<string | null> {
    const response = await this.executeHttpFetch(url, signal, headers);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      throw new ProviderFetchError(
        `${this.id} API HTTP ${response.status} for ${contextLabel ?? url}`,
        response.status,
        retryAfterMs,
      );
    }

    try {
      return await response.text();
    } catch {
      throw new ProviderFetchError(
        `Failed to read ${this.id} text response for ${contextLabel ?? url}`,
        undefined,
        undefined,
        false,
        true,
      );
    }
  }

  protected rankBestTitleCandidate<T>(
    candidates: T[],
    queryTitle: string,
    getTitle: (item: T) => string | undefined,
    threshold: number = TITLE_MATCH_THRESHOLD,
    options?: TitleCandidateRankingOptions<T>,
  ): { bestMatch: T | null; bestScore: number } {
    return rankBestTitleCandidate(
      candidates,
      queryTitle,
      getTitle,
      threshold,
      options,
    );
  }

  protected buildProviderResult(
    params: BuildProviderResultParams,
  ): ProviderResult {
    return buildProviderResult({
      ...params,
      provider: params.provider ?? this.id,
    });
  }
}

@Injectable()
export class RetractionScannerProvider {
  private readonly logger = new Logger(RetractionScannerProvider.name);

  async checkRetraction(
    doi?: string | null,
    pmid?: string | null,
    options?: { localOnly?: boolean },
  ): Promise<RetractionLookupResult> {
    return this.lookup(doi, pmid, options);
  }
  constructor(
    private readonly retractionDb: RetractionDatabaseService,
    @Optional() private readonly httpClient?: HttpClient,
  ) {}

  /**
   * Looks a paper up by DOI and/or PMID only (same matching keys as Zotero).
   * Order: local Retraction Watch dataset / in-memory index, then Crossref.
   */
  async lookup(
    doi?: string | null,
    pmid?: string | null,
    options?: { localOnly?: boolean },
  ): Promise<RetractionLookupResult> {
    const cleanDoiVal = doi
      ? normalizeDoi(doi) || doi.trim().toLowerCase()
      : undefined;
    const cleanPmidVal = pmid ? normalizePmid(pmid) || pmid.trim() : undefined;

    if (!cleanDoiVal && !cleanPmidVal) {
      return { status: 'unknown' };
    }

    const localResult = await this.retractionDb.checkRetraction(
      cleanDoiVal,
      cleanPmidVal,
    );
    if (localResult === false) return { status: 'clean' };
    if (localResult) return { status: 'retracted', details: localResult };

    if (options?.localOnly) {
      return { status: 'unknown' };
    }

    if (cleanDoiVal || cleanPmidVal) {
      try {
        const { retraction, isVerifiedClean } =
          await this.queryOnlineRetraction(cleanDoiVal, cleanPmidVal);
        if (retraction) {
          const isRetracted =
            retraction.nature === 'retraction' ||
            retraction.nature === 'Retraction' ||
            retraction.nature === 'manual';
          if (cleanDoiVal && isRetracted) {
            await this.retractionDb.saveRetraction(
              cleanDoiVal,
              retraction,
              cleanPmidVal,
            );
          }
          return { status: 'retracted', details: retraction };
        }
        if (isVerifiedClean) {
          if (cleanDoiVal) {
            await this.retractionDb.saveClean(cleanDoiVal, cleanPmidVal);
          }
          return { status: 'clean' };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Online retraction scan for ${cleanDoiVal || cleanPmidVal} skipped/failed: ${msg}`,
        );
      }
    }

    return { status: 'unknown' };
  }

  /**
   * Enterprise Online Retraction Detection (Standardized via OpenAlex & CrossRef):
   * 1. OpenAlex API: Ingests the entire Retraction Watch database (~55,000+ papers). Catches historical and preprint retractions.
   * 2. CrossRef CrossMark API: Real-time publisher update-to notices and retraction assertions.
   */
  private async executeFetch(
    url: string,
    options?: RequestInit,
  ): Promise<{ response: Response; attempts: number }> {
    if (this.httpClient) {
      const res = await this.httpClient.request(url, {
        signal: options?.signal ?? undefined,
        headers: options?.headers as Record<string, string> | undefined,
      });
      return { response: res.response, attempts: 1 };
    }
    const response = await fetch(url, options);
    return { response, attempts: 1 };
  }

  private async queryOnlineRetraction(
    doi?: string | null,
    pmid?: string | null,
  ): Promise<{
    retraction: RetractionDetails | null;
    isVerifiedClean: boolean;
  }> {
    const mailto = getContactEmail();

    // Tier 1: Check OpenAlex (Full Retraction Watch Registry)
    try {
      const openalexTarget = doi
        ? `https://doi.org/${doi}`
        : pmid
          ? `pmid:${pmid}`
          : null;

      if (openalexTarget) {
        const oaUrl = `https://api.openalex.org/works/${encodeURIComponent(openalexTarget)}?mailto=${encodeURIComponent(mailto)}`;
        const oaHeaders = {
          'User-Agent': getUserAgent('RetractionScanner'),
          Accept: 'application/json',
        };
        const oaSignal = AbortSignal.timeout(3500);
        const { response: oaRes } = await this.executeFetch(oaUrl, {
          headers: oaHeaders,
          signal: oaSignal,
        });

        if (oaRes.ok) {
          const oaData = (await oaRes.json()) as {
            is_retracted?: boolean;
            doi?: string;
            publication_date?: string;
          } | null;
          if (oaData?.is_retracted === true) {
            return {
              retraction: {
                nature: 'retraction',
                reason:
                  'Retracted according to Retraction Watch & OpenAlex global registry',
                noticeUrl: oaData.doi
                  ? oaData.doi.startsWith('http')
                    ? oaData.doi
                    : `https://doi.org/${oaData.doi}`
                  : undefined,
                date: oaData.publication_date || undefined,
                source: 'openalex',
              },
              isVerifiedClean: false,
            };
          }
        }
      }
    } catch (oaErr: unknown) {
      const msg = oaErr instanceof Error ? oaErr.message : String(oaErr);
      this.logger.debug(
        `[RetractionScanner] OpenAlex check skipped/failed: ${msg}`,
      );
    }

    // Tier 2: Check CrossRef CrossMark (Real-Time Publisher Notices)
    if (doi) {
      try {
        const crUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`;
        const crHeaders = {
          'User-Agent': getUserAgent('RetractionScanner'),
          Accept: 'application/json',
        };
        const crSignal = AbortSignal.timeout(3500);
        const { response: crRes } = await this.executeFetch(crUrl, {
          headers: crHeaders,
          signal: crSignal,
        });

        if (crRes.ok) {
          const crData = (await crRes.json()) as {
            message?: {
              'update-to'?: Array<{
                type?: string;
                doi?: string;
                label?: string;
                updated?: { 'date-time'?: string };
              }>;
              'updated-by'?: Array<{
                type?: string;
                doi?: string;
                label?: string;
                updated?: { 'date-time'?: string };
              }>;
              assertion?: Array<{
                name?: string;
                value?: string;
              }>;
            };
          } | null;
          const message = crData?.message;

          const updateTo = [
            ...(Array.isArray(message?.['updated-by'])
              ? message['updated-by']
              : []),
            ...(Array.isArray(message?.['update-to'])
              ? message['update-to']
              : []),
          ];
          if (Array.isArray(updateTo) && updateTo.length > 0) {
            let bestNotice: RetractionDetails | null = null;
            let bestRank = 0;

            for (const update of updateTo) {
              const updateType = (update.type || '').toLowerCase();
              const updateNoticeUrl = update.doi
                ? update.doi.startsWith('http')
                  ? update.doi
                  : `https://doi.org/${update.doi}`
                : undefined;
              if (
                updateType === 'retraction' ||
                updateType === 'withdrawal' ||
                updateType === 'removal'
              ) {
                return {
                  retraction: {
                    nature: 'retraction',
                    reason: update.label || 'Retracted by publisher',
                    noticeUrl: updateNoticeUrl,
                    date: update.updated?.['date-time'] || undefined,
                    source: 'crossref',
                  },
                  isVerifiedClean: false,
                };
              }
              if (
                (updateType === 'expression_of_concern' ||
                  updateType === 'expression-of-concern' ||
                  updateType === 'concern') &&
                bestRank < 2
              ) {
                bestRank = 2;
                bestNotice = {
                  nature: 'expression_of_concern',
                  reason:
                    update.label || 'Publisher issued expression of concern',
                  noticeUrl: updateNoticeUrl,
                  date: update.updated?.['date-time'] || undefined,
                  source: 'crossref',
                };
              }
              if (
                updateType === 'erratum' &&
                Boolean(updateNoticeUrl) &&
                bestRank < 1
              ) {
                bestRank = 1;
                bestNotice = {
                  nature: 'correction',
                  reason: update.label || 'Publisher issued correction/erratum',
                  noticeUrl: updateNoticeUrl,
                  date: update.updated?.['date-time'] || undefined,
                  source: 'crossref',
                };
              }
            }

            if (bestNotice) {
              return {
                retraction: bestNotice,
                isVerifiedClean: false,
              };
            }
          }

          const assertions = message?.assertion;
          if (Array.isArray(assertions)) {
            for (const ass of assertions) {
              const name = (ass.name || '').toLowerCase();
              if (name === 'retraction' || name === 'retracted') {
                return {
                  retraction: {
                    nature: 'retraction',
                    reason: ass.value || 'Publisher retraction notice recorded',
                    source: 'crossref',
                  },
                  isVerifiedClean: false,
                };
              }
            }
          }

          return { retraction: null, isVerifiedClean: true };
        }
      } catch (crErr: unknown) {
        const msg = crErr instanceof Error ? crErr.message : String(crErr);
        this.logger.debug(
          `[RetractionScanner] Crossref check failed for DOI "${doi}": ${msg}`,
        );
      }
    }

    return { retraction: null, isVerifiedClean: false };
  }
}

export { RetractionScannerProvider as RetractionScannerService };
