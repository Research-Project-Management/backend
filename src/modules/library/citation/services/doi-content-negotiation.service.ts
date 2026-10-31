import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import type { ReferenceData } from '@/modules/library/citation/types/citation.types';
import { normalizeWork } from '@/modules/library/citation/domain/citation.domain';
import {
  AcademicHttpClient,
  ExternalProviderException,
  LIBRARY_REDIS_KEYS,
  normalizeDoi,
  getAcademicUserAgent,
} from '@/modules/library/core';
import { ResilienceRegistryService } from '@/modules/library/core/resilience/resilience-registry.service';

export interface DoiCitationResult {
  styleId: string;
  bibliography: string;
  bibliographyHtml?: string;
  inText?: string;
  source: 'publisher';
}

@Injectable()
export class DoiContentNegotiationService {
  private readonly logger = new Logger(DoiContentNegotiationService.name);

  constructor(
    @Optional()
    private readonly resilienceRegistry?: ResilienceRegistryService,
    @Optional()
    private readonly httpClient?: AcademicHttpClient,
    @Optional()
    private readonly redisCache?: RedisCacheService,
  ) {}

  private static readonly REDIS_TTL_SECONDS = 24 * 60 * 60;

  // In-memory cache with TTL (24 hours) and bounded LRU pruning
  private readonly cache = new Map<
    string,
    { result: DoiCitationResult; expiresAt: number }
  >();

  // In-memory metadata cache with TTL (24 hours) and bounded LRU pruning
  private readonly metaCache = new Map<
    string,
    { result: ReferenceData; expiresAt: number }
  >();

  private setWithLru<T>(
    map: Map<string, { result: T; expiresAt: number }>,
    key: string,
    result: T,
    ttlMs: number = 24 * 60 * 60 * 1000,
    maxSize: number = 2000,
  ): void {
    const now = Date.now();
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= maxSize) {
      for (const [k, v] of map.entries()) {
        if (v.expiresAt <= now) {
          map.delete(k);
        }
      }
      if (map.size >= maxSize) {
        for (const k of map.keys()) {
          map.delete(k);
          if (map.size < maxSize) break;
        }
      }
    }
    map.set(key, { result, expiresAt: now + ttlMs });
  }

  private readonly STYLE_ACCEPT_MAP: Record<string, string> = {
    apa: 'text/bibliography; style=apa',
    'apa-7th': 'text/bibliography; style=apa',
    ieee: 'text/bibliography; style=ieee',
    nature: 'text/bibliography; style=nature',
    chicago: 'text/bibliography; style=chicago-author-date',
    'chicago-author-date': 'text/bibliography; style=chicago-author-date',
    mla: 'text/bibliography; style=modern-language-association',
    'mla-9th': 'text/bibliography; style=modern-language-association',
    vancouver: 'text/bibliography; style=vancouver',
    harvard: 'text/bibliography; style=harvard-cite-them-right',
    bibtex: 'application/x-bibtex',
    ris: 'application/x-research-info-systems',
  };

  isDoi(raw: string): boolean {
    return Boolean(normalizeDoi(raw));
  }

  /**
   * Resolves authoritative publisher-rendered citation directly from Crossref/DataCite.
   * Returns null if not resolvable or on timeout to allow graceful fallback.
   */
  async resolveCitation(
    rawDoi: string,
    styleId: string = 'apa',
    timeoutMs: number = 5000,
  ): Promise<DoiCitationResult | null> {
    const doi = normalizeDoi(rawDoi);
    if (!doi) return null;

    const normalizedStyle = (styleId || 'apa').toLowerCase();
    const acceptHeader = this.STYLE_ACCEPT_MAP[normalizedStyle];
    if (!acceptHeader) return null;
    const cacheKey = `${doi}:${normalizedStyle}`;
    const redisKey = LIBRARY_REDIS_KEYS.doiNegotiation(normalizedStyle, doi);

    // Check L1 cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    // Check L2 Redis cache
    if (this.redisCache?.get) {
      try {
        const l2Hit = await this.redisCache.get<DoiCitationResult>(redisKey);
        if (l2Hit && typeof l2Hit === 'object' && 'bibliography' in l2Hit) {
          this.setWithLru(this.cache, cacheKey, l2Hit);
          return l2Hit;
        }
      } catch {
        // Non-fatal fallback to fetch
      }
    }

    const executeFetch = async (): Promise<DoiCitationResult | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const url = `https://doi.org/${encodeURIComponent(doi)}`;
        const headers = {
          Accept: acceptHeader,
          'User-Agent': getAcademicUserAgent('Research'),
        };
        const response = this.httpClient
          ? (
              await this.httpClient.request(url, {
                headers,
                signal: controller.signal,
                timeoutMs,
              })
            ).response
          : await fetch(url, {
              headers,
              signal: controller.signal,
            });

        clearTimeout(timer);

        if (response.status === 404) {
          return null;
        }

        if (response.status === 429 || response.status >= 500) {
          throw new ExternalProviderException(
            `doi.org returned HTTP ${response.status}`,
            {
              status: response.status,
              url,
            },
          );
        }

        if (!response.ok) {
          return null;
        }

        const rawText = await response.text();
        const cleanedText = rawText.trim();
        if (!cleanedText || cleanedText.startsWith('<!DOCTYPE html>')) {
          return null; // Received HTML error page rather than bibliography
        }

        // Generate HTML with linkified DOI if present
        const bibliographyHtml = this.formatBibliographyHtml(cleanedText, doi);

        const result: DoiCitationResult = {
          styleId: normalizedStyle,
          bibliography: cleanedText,
          bibliographyHtml,
          source: 'publisher',
        };

        // Cache for 24h with bounded LRU eviction
        this.setWithLru(this.cache, cacheKey, result);
        await this.redisCache
          ?.set?.(
            redisKey,
            result,
            DoiContentNegotiationService.REDIS_TTL_SECONDS,
          )
          .catch(() => {});

        return result;
      } catch (err: unknown) {
        clearTimeout(timer);
        throw err;
      }
    };

    try {
      if (this.resilienceRegistry) {
        return await this.resilienceRegistry.execute('doi-org', executeFetch, {
          fallback: (err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.debug(
              `DOI Content Negotiation fallback for ${doi} (${normalizedStyle}): ${errMsg}`,
            );
            return Promise.resolve(null);
          },
        });
      }

      return await executeFetch();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `DOI Content Negotiation bypassed for ${doi} (${normalizedStyle}): ${errMsg}`,
      );
      return null;
    }
  }

  private formatBibliographyHtml(text: string, doi: string): string {
    const doiUrl = `https://doi.org/${doi}`;
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Linkify DOI URL
    if (html.includes(doiUrl)) {
      html = html.replace(
        doiUrl,
        `<a href="${doiUrl}" target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80">${doiUrl}</a>`,
      );
    } else if (html.includes(`doi:${doi}`)) {
      html = html.replace(
        `doi:${doi}`,
        `<a href="${doiUrl}" target="_blank" rel="noopener noreferrer" class="underline hover:opacity-80">doi:${doi}</a>`,
      );
    }

    return `<div class="csl-entry">${html}</div>`;
  }

  /**
   * Resolves full CSL-JSON metadata directly via DOI.org Content Negotiation.
   * Works for ALL registration agencies: CrossRef, DataCite (Zenodo, Figshare, Dryad), mEDRA, JaLC.
   */
  async resolveMetadata(
    rawDoi: string,
    timeoutMs: number = 6000,
  ): Promise<ReferenceData | null> {
    const doi = normalizeDoi(rawDoi);
    if (!doi) return null;

    // Check L1 metadata cache
    const cached = this.metaCache.get(doi);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const redisMetaKey = LIBRARY_REDIS_KEYS.doiNegotiation('meta', doi);
    if (this.redisCache?.get) {
      try {
        const l2Meta = await this.redisCache.get<ReferenceData>(redisMetaKey);
        if (l2Meta && typeof l2Meta === 'object' && 'title' in l2Meta) {
          this.setWithLru(this.metaCache, doi, l2Meta);
          return l2Meta;
        }
      } catch {
        // Non-fatal fallback to fetch
      }
    }

    const executeFetch = async (): Promise<ReferenceData | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const url = `https://doi.org/${encodeURIComponent(doi)}`;
        const headers = {
          Accept:
            'application/vnd.citationstyles.csl+json, application/citeproc+json, application/json',
          'User-Agent': getAcademicUserAgent('Research'),
        };
        const response = this.httpClient
          ? (
              await this.httpClient.request(url, {
                headers,
                signal: controller.signal,
                timeoutMs,
              })
            ).response
          : await fetch(url, {
              headers,
              signal: controller.signal,
            });

        clearTimeout(timer);

        if (response.status === 404) return null;

        if (response.status === 429 || response.status >= 500) {
          throw new ExternalProviderException(
            `doi.org metadata HTTP ${response.status}`,
            {
              status: response.status,
              url,
            },
          );
        }

        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) return null;

        const json = (await response.json()) as unknown;
        if (!json || typeof json !== 'object') return null;

        const result = normalizeWork(json, doi);
        if (!result || !result.title || result.title === 'Untitled')
          return null;

        // Cache metadata with bounded LRU eviction
        this.setWithLru(this.metaCache, doi, result);
        await this.redisCache
          ?.set?.(
            redisMetaKey,
            result,
            DoiContentNegotiationService.REDIS_TTL_SECONDS,
          )
          .catch(() => {});

        return result;
      } catch (err: unknown) {
        clearTimeout(timer);
        throw err;
      }
    };

    try {
      if (this.resilienceRegistry) {
        return await this.resilienceRegistry.execute('doi-org', executeFetch, {
          fallback: (err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.debug(
              `DOI Content Negotiation metadata fallback for ${doi}: ${errMsg}`,
            );
            return Promise.resolve(null);
          },
        });
      }

      return await executeFetch();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(
        `DOI Content Negotiation metadata resolution bypassed for ${doi}: ${errMsg}`,
      );
      return null;
    }
  }
}
