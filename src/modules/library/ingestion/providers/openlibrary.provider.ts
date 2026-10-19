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
  normalizeIsbn,
  normalizeAcademicTags,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
} from '@/modules/library/core';
import { ProviderFetchError } from '@/modules/library/ingestion/services/metadata-executor.service';
import { getAcademicUserAgent } from '@/modules/library/core/constants/academic-client.constants';
import { parseCreatorString } from '@/modules/library/core';

@Injectable()
export class OpenLibraryProvider implements MetadataProvider {
  readonly id: ProviderName = 'OpenLibrary';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['ISBN'],
    isAuthoritative: true,
    timeoutMs: 8000,
    maxConcurrency: 2,
  };

  constructor(
    private readonly httpClient: AcademicHttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {}

  private get baseUrl(): string {
    return (
      this.configService?.providers.openLibraryBaseUrl ??
      libraryConfig().providers.openLibraryBaseUrl
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
    const cleanIsbn = normalizeIsbn(request.query);
    if (!cleanIsbn) return null;

    const bibKey = `ISBN:${cleanIsbn}`;
    const url = `${this.baseUrl}?bibkeys=${encodeURIComponent(bibKey)}&format=json&jscmd=data`;

    const headers = {
      'User-Agent': getAcademicUserAgent('OpenLibrary'),
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
    const rawTitle =
      typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : 'Untitled Book';
    const rawSubtitle =
      typeof item.subtitle === 'string' && item.subtitle.trim()
        ? item.subtitle.trim()
        : undefined;
    const title =
      rawSubtitle && !rawTitle.includes(':')
        ? `${rawTitle}: ${rawSubtitle}`
        : rawTitle;
    const shortTitle =
      rawSubtitle && !rawTitle.includes(':') ? rawTitle : undefined;

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
      if (typeof firstPub.name === 'string' && firstPub.name.trim()) {
        publisher = firstPub.name.trim();
      }
    }

    let place: string | undefined;
    if (Array.isArray(item.publish_places) && item.publish_places[0]) {
      const firstPlace = item.publish_places[0] as { name?: string } | string;
      if (typeof firstPlace === 'string' && firstPlace.trim()) {
        place = firstPlace.trim();
      } else if (
        firstPlace &&
        typeof firstPlace === 'object' &&
        typeof firstPlace.name === 'string' &&
        firstPlace.name.trim()
      ) {
        place = firstPlace.name.trim();
      }
    }

    const edition =
      typeof item.edition_name === 'string' && item.edition_name.trim()
        ? item.edition_name.trim()
        : undefined;

    const rawSubjects: string[] = [];
    if (Array.isArray(item.subjects)) {
      for (const s of item.subjects.slice(0, 8)) {
        if (typeof s === 'string' && s.trim()) {
          rawSubjects.push(s.trim());
        } else if (
          s &&
          typeof s === 'object' &&
          typeof (s as { name?: string }).name === 'string' &&
          (s as { name: string }).name.trim()
        ) {
          rawSubjects.push((s as { name: string }).name.trim());
        }
      }
    }
    const keywords = normalizeAcademicTags(rawSubjects).slice(0, 8);

    const pages =
      typeof item.number_of_pages === 'number' ||
      typeof item.number_of_pages === 'string'
        ? String(item.number_of_pages)
        : undefined;
    const numberOfPages =
      pages && !Number.isNaN(Number(pages)) ? Number(pages) : undefined;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(item))
      .digest('hex');

    const rawUrl = typeof item.url === 'string' ? item.url : undefined;
    const canonicalUrl = rawUrl || `https://openlibrary.org/isbn/${cleanIsbn}`;

    const creators = authors.map((name, idx) =>
      parseCreatorString(name, idx, 'author'),
    );

    return {
      provider: this.id,
      metadata: {
        title,
        ...(shortTitle ? { shortTitle } : {}),
        authors,
        creators,
        year,
        isbn: cleanIsbn,
        publisher,
        ...(place ? { place } : {}),
        ...(edition ? { edition } : {}),
        pages,
        ...(pages ? { numPages: pages } : {}),
        ...(numberOfPages ? { numberOfPages } : {}),
        ...(keywords.length > 0 ? { keywords, tags: keywords } : {}),
        itemType: 'book',
        url: canonicalUrl,
        libraryCatalog: 'Open Library',
        extraFields: {
          numPages: pages,
          ...(numberOfPages ? { numberOfPages } : {}),
          isbn: cleanIsbn,
          ...(place ? { place } : {}),
          ...(edition ? { edition } : {}),
        },
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
