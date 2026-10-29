import { Injectable, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  normalizeDoi,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
} from '@/modules/library/core';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '@/modules/library/core/constants/academic-client.constants';

@Injectable()
export class UnpaywallProvider implements MetadataProvider {
  readonly id: ProviderName = 'Unpaywall';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI'],
    isAuthoritative: false,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  constructor(
    private readonly httpClient: AcademicHttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {}

  private get baseUrl(): string {
    return (
      this.configService?.providers.unpaywallBaseUrl ??
      libraryConfig().providers.unpaywallBaseUrl
    );
  }

  private get email(): string {
    return (
      this.configService?.providers.unpaywallEmail ??
      libraryConfig().providers.unpaywallEmail ??
      getAcademicContactEmail()
    );
  }

  supports(input: QueryType | MetadataRequest): boolean {
    const type = typeof input === 'string' ? input : input?.queryType;
    return type ? this.capabilities.queryTypes.includes(type) : false;
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanDoi = normalizeDoi(request.query);
    if (!cleanDoi) return null;

    const url = `${this.baseUrl}/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(this.email)}`;

    const headers = {
      'User-Agent': getAcademicUserAgent('Unpaywall'),
      Accept: 'application/json',
    };

    const { response } = await this.httpClient.request(url, {
      headers,
      signal,
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : undefined;
      throw new ProviderFetchError(
        `Unpaywall API HTTP ${response.status} for DOI: ${cleanDoi}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse Unpaywall JSON for DOI: ${cleanDoi}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as {
      is_oa?: boolean;
      title?: string;
      journal_name?: string;
      best_oa_location?: {
        url_for_pdf?: string;
        url?: string;
      };
    } | null;

    const isOa = Boolean(payload?.is_oa);
    const bestOaLocation = payload?.best_oa_location;
    // Strict Full-text resolver: Only treat as openAccessPdfUrl if it is explicitly a direct PDF URL
    // or a non-DOI URL (to avoid polluting openAccessPdfUrl with DOI landing page redirect loops)
    const rawOaCandidate = bestOaLocation?.url_for_pdf || bestOaLocation?.url || undefined;
    const isDirectPdfUrl = Boolean(
      bestOaLocation?.url_for_pdf ||
      (rawOaCandidate && /\.pdf(?:$|\?|#)/i.test(rawOaCandidate)) ||
      (rawOaCandidate && !/^https?:\/\/(?:dx\.)?doi\.org\//i.test(rawOaCandidate))
    );
    const pdfUrl = isDirectPdfUrl ? rawOaCandidate : undefined;

    const hasMetadata = Boolean(payload?.title || pdfUrl);
    if (!hasMetadata) return null;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(payload))
      .digest('hex');

    return {
      provider: this.id,
      metadata: {
        doi: cleanDoi,
        title: typeof payload?.title === 'string' ? payload.title : undefined,
        journal:
          typeof payload?.journal_name === 'string'
            ? payload.journal_name
            : undefined,
        openAccessPdfUrl: pdfUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: `doi:${cleanDoi}`,
          canonicalUrl: `https://doi.org/${cleanDoi}`,
          confidenceScore: 0.99,
          rawSnapshotHash: rawVersion,
          isOpenAccess: isOa,
          openAccessPdfUrl: pdfUrl,
        },
      },
      confidence: 0.99,
      identifier: cleanDoi,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
