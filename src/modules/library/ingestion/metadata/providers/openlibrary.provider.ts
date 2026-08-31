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
import { normalizeIsbn } from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

@Injectable()
export class OpenLibraryProvider implements MetadataProvider {
  readonly id: ProviderName = 'OpenLibrary';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['ISBN'],
    isAuthoritative: true,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  private readonly logger = new Logger(OpenLibraryProvider.name);
  private readonly BASE_URL = 'https://openlibrary.org/api/books';

  supports(queryType: QueryType): boolean {
    return this.capabilities.queryTypes.includes(queryType);
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const cleanIsbn = normalizeIsbn(request.query);
    if (!cleanIsbn) return null;

    const bibKey = `ISBN:${cleanIsbn}`;
    const url = `${this.BASE_URL}?bibkeys=${encodeURIComponent(bibKey)}&format=json&jscmd=data`;

    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'FluxResearchPlatform/1.0 (mailto:contact@flux.academic; https://flux.study)',
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
        `OpenLibrary API HTTP ${response.status} for ISBN: ${cleanIsbn}`,
        response.status,
        retryAfterMs,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderFetchError(
        `Failed to parse OpenLibrary JSON for ISBN: ${cleanIsbn}`,
        undefined,
        undefined,
        false,
        true,
      );
    }

    const payload = json as Record<string, Record<string, unknown>> | null;
    const item = payload?.[bibKey];
    if (!item) return null;

    return this.transformPayload(item, cleanIsbn);
  }

  private transformPayload(
    item: Record<string, unknown>,
    cleanIsbn: string,
  ): ProviderResult {
    const rawTitle = typeof item.title === 'string' ? item.title.trim() : 'Untitled Book';
    const title = rawTitle || 'Untitled Book';

    const authors: string[] = [];
    if (Array.isArray(item.authors)) {
      for (const a of item.authors) {
        if (
          a &&
          typeof a === 'object' &&
          typeof (a as { name?: string }).name === 'string'
        ) {
          authors.push((a as { name: string }).name.trim());
        }
      }
    }

    let year: number | null = null;
    if (typeof item.publish_date === 'string') {
      const match = item.publish_date.match(/(\d{4})/);
      if (match) year = Number(match[1]);
    }

    let publisher: string | undefined;
    if (Array.isArray(item.publishers) && item.publishers[0]) {
      const firstPub = item.publishers[0] as { name?: string };
      if (typeof firstPub.name === 'string') {
        publisher = firstPub.name;
      }
    }

    const pages =
      typeof item.number_of_pages === 'number' || typeof item.number_of_pages === 'string'
        ? String(item.number_of_pages)
        : undefined;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const rawUrl = typeof item.url === 'string' ? item.url : undefined;
    const canonicalUrl = rawUrl || `https://openlibrary.org/isbn/${cleanIsbn}`;

    return {
      provider: this.id,
      metadata: {
        title,
        authors,
        year,
        isbn: cleanIsbn,
        publisher,
        pages,
        itemType: 'book',
        url: canonicalUrl,
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId: `isbn:${cleanIsbn}`,
          canonicalUrl,
          confidenceScore: 0.95,
          rawSnapshotHash: rawVersion,
          isOpenAccess: false,
        },
      },
      confidence: 0.95,
      identifier: cleanIsbn,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
