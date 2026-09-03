import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '../types/metadata.types';
import { normalizeDoi } from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

@Injectable()
export class UnpaywallProvider implements MetadataProvider {
  readonly id: ProviderName = 'Unpaywall';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI'],
    isAuthoritative: false,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(UnpaywallProvider.name);
  private readonly BASE_URL = 'https://api.unpaywall.org/v2';

  private get email(): string {
    return (
      process.env.UNPAYWALL_EMAIL ||
      process.env.ACADEMIC_EMAIL ||
      'contact@flux.academic'
    );
  }

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanDoi = normalizeDoi(request.query);
    if (!cleanDoi) return null;

    const url = `${this.BASE_URL}/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(this.email)}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': `FluxResearchPlatform/1.0 (academic-research-bot; mailto:${this.email})`,
        Accept: 'application/json',
      },
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
    const pdfUrl =
      bestOaLocation?.url_for_pdf || bestOaLocation?.url || undefined;

    if (!pdfUrl) return null;

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
