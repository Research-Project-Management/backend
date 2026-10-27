import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  ItemMetadata,
  MetadataProvider,
  MetadataRequest,
  Provenance,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  AcademicHttpClient,
  TITLE_MATCH_THRESHOLD,
  titleSimilarity,
} from '@/modules/library/core';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';

export type ProviderQueryInput =
  | QueryType
  | MetadataRequest
  | { type?: QueryType; queryType?: QueryType };

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

export function buildAcademicProviderResult(
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
  const effectiveIsOpenAccess =
    isOpenAccess ?? Boolean(effectiveOpenAccessUrl);

  const provenance: Provenance = {
    ...(metadata.provenance ?? {}),
    provider,
    originProvider: provider,
    resolvedAt,
    canonicalId:
      canonicalId ??
      (metadata.provenance as { canonicalId?: string } | undefined)?.canonicalId ??
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

export function rankBestTitleCandidate<T>(
  candidates: T[],
  queryTitle: string,
  getTitle: (item: T) => string | undefined,
  threshold: number = TITLE_MATCH_THRESHOLD,
): { bestMatch: T | null; bestScore: number } {
  const cleanQuery = queryTitle.trim();
  if (!cleanQuery || !Array.isArray(candidates) || candidates.length === 0) {
    return { bestMatch: null, bestScore: 0 };
  }

  let bestCandidate: T | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const candidateTitle = getTitle(candidate) ?? '';
    if (!candidateTitle) continue;
    const score = titleSimilarity(cleanQuery, candidateTitle);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate || bestScore < threshold) {
    return { bestMatch: null, bestScore };
  }

  return { bestMatch: bestCandidate, bestScore };
}

/**
 * GoF Template Method Pattern — `AbstractAcademicProvider`
 *
 * Consolidates shared HTTP transport, HTTP 429/5xx `Retry-After` error propagation
 * for `CircuitBreaker` awareness, title candidate similarity ranking, and deterministic
 * `ProviderResult` construction with MD5 `rawSnapshotHash` and `provenance`.
 */
export abstract class AbstractAcademicProvider implements MetadataProvider {
  abstract readonly id: ProviderName;
  abstract readonly capabilities: ProviderCapability;

  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly httpClient?: AcademicHttpClient) {}

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
            typeof (responseOrHeader as Response).headers?.get === 'function'
          ? (responseOrHeader as Response).headers.get('retry-after')
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
  ): { bestMatch: T | null; bestScore: number } {
    return rankBestTitleCandidate(candidates, queryTitle, getTitle, threshold);
  }

  protected buildProviderResult(
    params: BuildProviderResultParams,
  ): ProviderResult {
    return buildAcademicProviderResult({
      ...params,
      provider: params.provider ?? this.id,
    });
  }
}
