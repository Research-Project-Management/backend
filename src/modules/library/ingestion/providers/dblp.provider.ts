import { Injectable, Optional } from '@nestjs/common';
import {
  MetadataRequest,
  ProviderCapability,
  ProviderName,
  ProviderResult,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  cleanBibliographicText,
  normalizeDoi,
  normalizePageRange,
  parseCreatorString,
  AcademicHttpClient,
  LibraryConfigService,
  libraryConfig,
} from '@/modules/library/core';
import { getAcademicUserAgent } from '@/modules/library/core/constants/academic-client.constants';
import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';
import { AbstractAcademicProvider } from './abstract-academic.provider';

/**
 * DBLP Computer Science Bibliography Provider.
 *
 * Gold standard open bibliographic database for computer science, AI, and software engineering.
 * Fast, open API with zero recurring cost and authoritative proceedings indexing for
 * NeurIPS, ICML, ICLR, CVPR, ICCV, ECCV, ACL, EMNLP, IEEE, and ACM conferences.
 */
@Injectable()
export class DblpProvider extends AbstractAcademicProvider {
  readonly id: ProviderName = 'DBLP';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['DOI', 'TITLE'],
    isAuthoritative: false,
    timeoutMs: 5000,
    maxConcurrency: 2,
  };

  constructor(
    @Optional() private readonly rateLimiter?: DomainRateLimiterService,
    httpClient?: AcademicHttpClient,
    @Optional() private readonly configService?: LibraryConfigService,
  ) {
    super(httpClient);
  }

  private get baseUrl(): string {
    return (
      this.configService?.providers.dblpBaseUrl ??
      libraryConfig().providers.dblpBaseUrl
    );
  }

  async resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const rawQuery = request.query?.trim();
    if (!rawQuery) return null;

    const cleanDoi = normalizeDoi(rawQuery);
    const isDoiQuery = Boolean(cleanDoi) || request.queryType === 'DOI';

    const searchQuery = isDoiQuery && cleanDoi ? `doi:${cleanDoi}` : rawQuery;
    const url = `${this.baseUrl}?q=${encodeURIComponent(searchQuery)}&format=json&h=3`;

    if (this.rateLimiter) {
      await this.rateLimiter.acquire('dblp', signal);
    }

    const headers = {
      'User-Agent': getAcademicUserAgent('Dblp'),
      Accept: 'application/json, text/json',
    };

    const payload = await this.fetchJsonWithResilience<Record<string, unknown>>(
      url,
      signal,
      headers,
      {
        contextLabel: `query: ${searchQuery}`,
        swallowNetworkError: true,
      },
    );
    if (!payload) return null;

    const hits = (
      payload as {
        result?: {
          hits?: {
            hit?:
              | Array<{ info?: Record<string, unknown> }>
              | { info?: Record<string, unknown> };
          };
        };
      }
    )?.result?.hits?.hit;
    if (!hits) return null;

    const hitList = Array.isArray(hits) ? hits : [hits];
    if (hitList.length === 0) return null;

    const firstHit = hitList[0]?.info;
    if (!firstHit || !firstHit.title) return null;

    return this.mapHitToProviderResult(
      firstHit,
      isDoiQuery ? cleanDoi || rawQuery : rawQuery,
      isDoiQuery,
    );
  }

  private mapHitToProviderResult(
    info: Record<string, unknown>,
    identifier: string,
    isDoiQuery: boolean,
  ): ProviderResult {
    // 1. Clean Title (DBLP titles often end with a dot)
    const rawTitle =
      typeof info.title === 'string'
        ? info.title
        : (info.title as { text?: string })?.text || '';
    const cleanTitle = (cleanBibliographicText(rawTitle) || '')
      .replace(/\.$/, '')
      .trim();

    // 2. Authors
    const rawAuthors = (info.authors as { author?: unknown })?.author;
    const authorNames: string[] = [];
    if (Array.isArray(rawAuthors)) {
      for (const a of rawAuthors) {
        const name = typeof a === 'string' ? a : (a as { text?: string })?.text;
        if (name && typeof name === 'string')
          authorNames.push(name.replace(/\s+\d+$/, '')); // Strip DBLP disambiguation digits (e.g. "John Smith 0001")
      }
    } else if (rawAuthors) {
      const name =
        typeof rawAuthors === 'string'
          ? rawAuthors
          : (rawAuthors as { text?: string })?.text;
      if (name && typeof name === 'string')
        authorNames.push(name.replace(/\s+\d+$/, ''));
    }

    const creators = authorNames.map((a, idx) =>
      parseCreatorString(a, idx, 'author'),
    );

    const toStr = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

    // 3. Year
    let year: number | undefined;
    if (info.year) {
      const parsedYear = parseInt(toStr(info.year), 10);
      if (!isNaN(parsedYear) && parsedYear >= 1900 && parsedYear <= 2100) {
        year = parsedYear;
      }
    }

    // 4. Item Type & Venue
    const rawType = toStr(info.type).toLowerCase();
    const venue =
      typeof info.venue === 'string' ? info.venue.trim() : undefined;
    const isConference =
      rawType.includes('conference') || rawType.includes('workshop');

    const itemType = isConference ? 'conferencePaper' : 'journalArticle';
    const doi =
      typeof info.doi === 'string' ? normalizeDoi(info.doi) : undefined;
    const pagesStr = toStr(info.pages);
    const pages = pagesStr ? normalizePageRange(pagesStr) : undefined;
    const volume = toStr(info.volume) || undefined;
    const issue = toStr(info.number) || undefined;
    const url =
      typeof info.ee === 'string'
        ? info.ee
        : typeof info.url === 'string'
          ? info.url
          : undefined;

    return this.buildProviderResult({
      identifier,
      confidenceScore: isDoiQuery ? 0.9 : 0.85,
      rawPayload: { title: cleanTitle, venue, year, doi },
      retrievalMethod: 'api',
      sourceUrl: url,
      canonicalId: doi ? `doi:${doi}` : `dblp:${identifier}`,
      metadata: {
        itemType,
        title: cleanTitle,
        creators: creators,
        authors: authorNames,
        year,
        doi,
        journal: !isConference ? venue : undefined,
        publicationTitle: venue,
        proceedingsTitle: isConference ? venue : undefined,
        conferenceName: isConference ? venue : undefined,
        pages,
        volume,
        issue,
        url,
      },
    });
  }
}
