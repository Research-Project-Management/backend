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
import { cleanBibliographicText } from '../utils/metadata.utils';
import { ProviderFetchError } from '../services/provider.executor';

/**
 * CORE API metadata provider — 40M+ open access full-text papers.
 *
 * CORE (core.ac.uk) aggregates open access research from 10,000+ repositories.
 * Unique value: full-text OA content, not just metadata — complements CrossRef/OpenAlex.
 * Rate limit: 1 req/10s (free tier). Implements self-throttling.
 *
 * API docs: https://api.core.ac.uk/docs/v3
 * Register free key: https://core.ac.uk/services/api
 *
 * License: Free API. Data under CC licenses per source repository.
 */
@Injectable()
export class CoreProvider implements MetadataProvider {
  readonly id: ProviderName = 'CORE';
  readonly capabilities: ProviderCapability = {
    queryTypes: ['TITLE'],
    isAuthoritative: false,
    timeoutMs: 15_000,
    maxConcurrency: 1, // Rate limit: 1 req/10s — must not be called concurrently
  };

  private readonly logger = new Logger(CoreProvider.name);
  private readonly BASE_URL = 'https://api.core.ac.uk/v3';

  /** Timestamp of last request — for self-throttling */
  private lastRequestAt = 0;
  private readonly MIN_INTERVAL_MS = 10_000; // 1 req / 10s (free tier)

  private get apiKey(): string | undefined {
    return process.env.CORE_API_KEY;
  }

  private get email(): string {
    return (
      process.env.ACADEMIC_EMAIL ??
      process.env.CROSSREF_EMAIL ??
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
    if (!this.apiKey) {
      this.logger.debug('CORE_API_KEY not configured — skipping CORE provider');
      return null;
    }

    const { query } = request;
    if (!query?.trim()) return null;

    // Self-throttle to respect 1 req/10s rate limit
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.MIN_INTERVAL_MS && this.lastRequestAt > 0) {
      const wait = this.MIN_INTERVAL_MS - elapsed;
      this.logger.debug(`CORE self-throttle: waiting ${wait}ms before request`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    return this.searchByTitle(query.trim(), signal);
  }

  private async searchByTitle(
    title: string,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null> {
    const params = new URLSearchParams({
      q: `title:"${title}"`,
      limit: '3',
      fields: 'id,title,authors,doi,abstract,yearPublished,publishedIn,downloadUrl,oaStatus,language',
    });

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `FluxResearchPlatform/1.0 (mailto:${this.email})`,
      Authorization: `Bearer ${this.apiKey}`,
    };

    this.lastRequestAt = Date.now();

    let responseText: string;
    try {
      const response = await fetch(`${this.BASE_URL}/search/works?${params}`, {
        headers,
        signal,
      });

      if (response.status === 429) {
        this.logger.warn('CORE API rate limited (429) — backing off');
        throw new ProviderFetchError('CORE API rate limited', 429, 60_000);
      }

      if (response.status === 401) {
        this.logger.warn('CORE API key invalid or expired (401)');
        return null;
      }

      if (!response.ok) {
        throw new ProviderFetchError(
          `CORE API HTTP ${response.status}`,
          response.status,
          undefined,
          false,
        );
      }

      responseText = await response.text();
    } catch (err: any) {
      if (err instanceof ProviderFetchError) throw err;
      if (err?.name === 'AbortError') throw err;
      throw new ProviderFetchError(`CORE request failed: ${err?.message}`, 0, undefined, true);
    }


    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      return null;
    }

    const results: any[] = data?.results ?? [];
    if (results.length === 0) return null;

    const best = this.pickBestMatch(results, title);
    if (!best) return null;

    return this.mapToProviderResult(best, title);
  }

  private pickBestMatch(results: any[], queryTitle: string): any | null {
    const normalize = (t: string) =>
      t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

    const qNorm = normalize(queryTitle);

    for (const r of results) {
      if (!r?.title) continue;
      const rNorm = normalize(String(r.title));
      if (rNorm.includes(qNorm.slice(0, 30)) || qNorm.includes(rNorm.slice(0, 30))) {
        return r;
      }
    }

    return results[0] ?? null;
  }

  private mapToProviderResult(work: any, queryTitle: string): ProviderResult {
    const authors: string[] = [];
    const creators: Array<{
      orderIndex: number;
      creatorType: string;
      firstName?: string;
      lastName?: string;
      fullName: string;
    }> = [];

    if (Array.isArray(work.authors)) {
      for (const a of work.authors) {
        const name =
          typeof a === 'string'
            ? a.trim()
            : typeof a?.name === 'string'
              ? a.name.trim()
              : null;

        if (name && name.length > 1) {
          authors.push(name);
          creators.push({
            orderIndex: creators.length,
            creatorType: 'author',
            fullName: name,
          });
        }
      }
    }

    const title = work.title
      ? (cleanBibliographicText(String(work.title))?.slice(0, 500) || queryTitle)
      : queryTitle;

    const abstract = work.abstract
      ? cleanBibliographicText(String(work.abstract))?.slice(0, 3000)
      : undefined;


    const doi = work.doi
      ? String(work.doi)
          .replace(/^https?:\/\/doi\.org\//i, '')
          .replace(/\s+/g, '')
          .toLowerCase()
      : undefined;

    const year =
      typeof work.yearPublished === 'number'
        ? work.yearPublished
        : typeof work.yearPublished === 'string'
          ? parseInt(work.yearPublished, 10) || undefined
          : undefined;

    const journal =
      typeof work.publishedIn === 'string'
        ? cleanBibliographicText(work.publishedIn)
        : undefined;

    const openAccessPdfUrl =
      typeof work.downloadUrl === 'string' && work.downloadUrl.startsWith('http')
        ? work.downloadUrl
        : undefined;

    const isOpenAccess = work.oaStatus === 'open' || !!openAccessPdfUrl;

    const language =
      typeof work.language?.code === 'string'
        ? work.language.code.toLowerCase()
        : typeof work.language === 'string'
          ? work.language.toLowerCase()
          : undefined;

    const rawVersion = createHash('md5')
      .update(JSON.stringify(work))
      .digest('hex');

    const canonicalId = doi ? `doi:${doi}` : `core:${work.id ?? queryTitle}`;
    const confidence = doi ? 0.75 : 0.55;

    return {
      provider: this.id,
      metadata: {
        doi,
        title,
        authors,
        creators,
        year: year ?? null,
        abstract,
        journal,
        publicationTitle: journal,
        language,
        itemType: 'journalArticle',
        provenance: {
          originProvider: this.id,
          resolvedAt: new Date().toISOString(),
          canonicalId,
          confidenceScore: confidence,
          rawSnapshotHash: rawVersion,
          isOpenAccess,
          openAccessPdfUrl,
        },
      },
      confidence,
      identifier: doi ?? queryTitle,
      fetchedAt: new Date().toISOString(),
      rawVersion,
    };
  }
}
