import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MetadataProvider,
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
  QueryType,
} from '../metadata.contracts';
import { normalizeIsbn } from '../metadata.identifiers';
import { ProviderFetchError } from '../metadata.executor';

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

    let json: any;
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

    const item = json?.[bibKey];
    if (!item) return null;

    return this.transformPayload(item, cleanIsbn);
  }

  private transformPayload(item: any, cleanIsbn: string): ProviderResult {
    const title = item.title || 'Untitled Book';

    const authors: string[] = Array.isArray(item.authors)
      ? item.authors.map((a: any) => a.name).filter(Boolean)
      : [];

    let year: number | null = null;
    if (item.publish_date) {
      const match = item.publish_date.match(/(\d{4})/);
      if (match) year = Number(match[1]);
    }

    const publisher =
      Array.isArray(item.publishers) && item.publishers[0]?.name
        ? item.publishers[0].name
        : undefined;

    const pages = item.number_of_pages
      ? String(item.number_of_pages)
      : undefined;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const canonicalUrl =
      item.url || `https://openlibrary.org/isbn/${cleanIsbn}`;

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
