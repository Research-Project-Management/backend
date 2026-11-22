import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  ItemMetadata,
  MetadataProvider,
  MetadataRequest,
  Provenance,
  ProviderCapability,
  ProviderFetchError,
  ProviderName,
  ProviderResult,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  HttpClient,
  TITLE_MATCH_THRESHOLD,
  titleSimilarity,
  extractNormalizedAuthorSurnames,
} from '@/modules/library/core';
type ProviderQueryInput =
  QueryType | MetadataRequest | { type?: QueryType; queryType?: QueryType };

interface BuildProviderResultParams {
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

function computeRawSnapshotHash(rawPayload: unknown): string {
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

interface TitleCandidateRankingOptions<T> {
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
      await response.body?.cancel().catch(() => {});
      return null;
    }

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      await response.body?.cancel().catch(() => {});
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
      await response.body?.cancel().catch(() => {});
      return null;
    }

    if (!response.ok) {
      const retryAfterMs = this.parseRetryAfterHeader(response);
      await response.body?.cancel().catch(() => {});
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
