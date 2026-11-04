import { Injectable, Logger, Optional, BadRequestException, ForbiddenException } from '@nestjs/common';
import { SsrfGuardService, ExternalProviderException, readSafeResponseText, parseCreatorString, getUserAgent, HttpClient } from '@/modules/library/core';
import { parseFeedXml, ParsedFeed } from '@/modules/library/ingestion/parsers/rss-atom-feed.parser';
import { FeedsRepository, type CachedFeedWithItems } from '@/modules/library/ingestion/repositories/feeds.repository';
import { CrossRefProvider } from '@/modules/library/ingestion/providers/crossref.provider';
import { RedisCacheService } from '@/core';

export function redactFeedUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/[^/@]+@/, '//').split(/[?#]/)[0];
  }
}

@Injectable()
export class FeedRetrievalService {
  private readonly logger = new Logger(FeedRetrievalService.name);
  private readonly inflightFeedRequests = new Map<
    string,
    Promise<ParsedFeed>
  >();

  constructor(
    @Optional() private readonly feedsRepo?: FeedsRepository,
    @Optional() private readonly ssrfGuard?: SsrfGuardService,
    @Optional() private readonly crossRefProvider?: CrossRefProvider,
    @Optional() private readonly httpClient?: HttpClient,
  ) {}

  /**
   * Resilient Academic RSS / Atom Feed Fetcher.
   * 1. Data Pooling & Anti-Spam: Returns cached DB articles on recent lookups
   * 2. Singleflight Pattern: Coalesces parallel requests for the same feed URL into a single fetch
   * 3. HTTP Conditional GET with ETag & If-Modified-Since (saves 100% bandwidth on 304)
   * 4. Upserts parsed entries into shared `feed_items` pool
   */
  async fetchAcademicFeed(
    feedUrl: string,
    forceRefresh = false,
    userId?: string,
  ): Promise<ParsedFeed> {
    if (!feedUrl || typeof feedUrl !== 'string') {
      throw new BadRequestException('A valid feed URL is required');
    }
    const trimmed = feedUrl.trim();

    if (this.feedsRepo?.isAvailable) {
      try {
        const cachedFeed = await this.feedsRepo.findFeedWithRecentItemsByUrl(
          trimmed,
          100,
        );

        // Centralized 1-IP SaaS Protection:
        // Academic journals/preprints update 1-4 times/day.
        // Normal reads serve from the shared DB pool for up to 120 minutes (2 hours).
        // Even explicit user "Refresh" requests enforce a strict 30-minute server-wide cooldown
        // per unique feed URL so N users clicking refresh never trigger outbound IP rate limits.
        const cooldownMinutes = forceRefresh ? 30 : 120;
        const cooldownThreshold = new Date(
          Date.now() - cooldownMinutes * 60 * 1000,
        );

        if (
          cachedFeed &&
          cachedFeed.lastFetchedAt &&
          cachedFeed.lastFetchedAt > cooldownThreshold &&
          cachedFeed.items.length > 0
        ) {
          if (forceRefresh) {
            this.logger.log(
              `User requested refresh for "${redactFeedUrl(trimmed)}", serving virtualized snapshot from shared DB pool (last fetched at ${cachedFeed.lastFetchedAt.toISOString()}) to protect server IP.`,
            );
          }
          const mapped = this.feedsRepo.mapCachedFeedToParsedFeed(cachedFeed);
          return this.hydrateReadStates(mapped, userId);
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Could not read feed from DB: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const existingPromise = this.inflightFeedRequests.get(trimmed);
    if (existingPromise) {
      const res = await existingPromise;
      return this.hydrateReadStates(res, userId);
    }

    const fetchPromise = this.executeFetchAndPersistFeed(trimmed);
    this.inflightFeedRequests.set(trimmed, fetchPromise);

    try {
      const res = await fetchPromise;
      return this.hydrateReadStates(res, userId);
    } finally {
      this.inflightFeedRequests.delete(trimmed);
    }
  }

  private async hydrateReadStates(
    feed: ParsedFeed,
    userId?: string,
  ): Promise<ParsedFeed> {
    if (
      !userId ||
      !this.feedsRepo?.findReadItemIdsForUser ||
      !Array.isArray(feed.entries) ||
      feed.entries.length === 0
    ) {
      return feed;
    }
    try {
      const readSet = await this.feedsRepo.findReadItemIdsForUser(
        userId,
        feed.entries.map((e) => e.id).filter(Boolean),
      );
      return {
        ...feed,
        entries: feed.entries.map((e) => ({
          ...e,
          isRead: readSet.has(e.id),
        })),
      };
    } catch {
      return feed;
    }
  }

  private async executeFetchAndPersistFeed(
    trimmed: string,
  ): Promise<ParsedFeed> {
    let existingFeedRecord: CachedFeedWithItems | null = null;
    if (this.feedsRepo?.isAvailable) {
      try {
        existingFeedRecord = await this.feedsRepo.findFeedWithRecentItemsByUrl(
          trimmed,
          50,
        );
      } catch {
        // ignore db lookup failure
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': getUserAgent('FeedReader'),
      Accept:
        'application/atom+xml, application/rss+xml, application/rdf+xml, application/xml, text/xml, */*;q=0.8',
    };

    if (existingFeedRecord?.etag) {
      headers['If-None-Match'] = existingFeedRecord.etag;
    }
    if (existingFeedRecord?.lastModified) {
      headers['If-Modified-Since'] = existingFeedRecord.lastModified;
    }

    let response: Response;
    try {
      const guard = this.ssrfGuard ?? new SsrfGuardService();
      response = await guard.safeFetch(trimmed, {
        method: 'GET',
        headers,
      });
    } catch (err: unknown) {
      if (
        err instanceof BadRequestException ||
        err instanceof ForbiddenException ||
        (err instanceof Error &&
          (err.message.includes('SSRF Protection') ||
            err.message.includes('SSRF')))
      ) {
        throw err;
      }
      this.logger.warn(
        `Direct fetch failed for feed "${redactFeedUrl(trimmed)}": ${err instanceof Error ? err.message : String(err)}. Attempting search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    if (
      response.status === 304 &&
      existingFeedRecord &&
      existingFeedRecord.items?.length > 0 &&
      this.feedsRepo
    ) {
      this.logger.log(
        `Feed "${redactFeedUrl(trimmed)}" returned 304 Not Modified. Reusing existing articles.`,
      );
      await this.feedsRepo.markFeedPollSuccess(existingFeedRecord.id, 304);
      return this.feedsRepo.mapCachedFeedToParsedFeed(existingFeedRecord);
    }

    if (!response.ok || response.status === 403 || response.status === 503) {
      this.logger.warn(
        `Feed returned HTTP ${response.status} (likely Cloudflare / Bot Protection) for "${redactFeedUrl(trimmed)}". Initiating academic search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    const xml = await readSafeResponseText(response);
    if (
      xml.includes('<!DOCTYPE html') ||
      xml.includes('challenge-running') ||
      xml.includes('cf-browser-verification')
    ) {
      this.logger.warn(
        `Feed URL "${redactFeedUrl(trimmed)}" returned HTML Cloudflare challenge page. Initiating academic search fallback...`,
      );
      return this.fallbackSearchFeed(trimmed);
    }

    const parsed = parseFeedXml(xml);
    const parsedFeed: ParsedFeed = {
      ...parsed,
      feedUrl: parsed.feedUrl || trimmed,
    };

    const etagHeader = response.headers.get('etag') || undefined;
    const lastModifiedHeader =
      response.headers.get('last-modified') || undefined;
    if (this.feedsRepo) {
      try {
        const persisted = await this.feedsRepo.persistFetchedFeedAndItems({
          feedUrl: trimmed,
          parsed: parsedFeed,
          etag: etagHeader,
          lastModified: lastModifiedHeader,
        });
        if (persisted?.items && persisted.items.length > 0) {
          const idByGuid = new Map<string, string>();
          for (const item of persisted.items) {
            if (item.guid && item.id) {
              idByGuid.set(item.guid, item.id);
            }
          }
          parsedFeed.entries = parsedFeed.entries.map((e, idx) => {
            const guid = (
              e.doi ||
              e.arxivId ||
              e.url ||
              e.id ||
              e.title ||
              ''
            ).trim();
            const matchedId =
              (guid ? idByGuid.get(guid) : undefined) ||
              (persisted.items.length === parsedFeed.entries.length
                ? persisted.items[idx]?.id
                : undefined);
            return {
              ...e,
              id: matchedId || e.id,
            };
          });
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to persist feed to database: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return parsedFeed;
  }

  private async fallbackSearchFeed(
    feedUrl: string,
  ): Promise<ParsedFeed> {
    const redactedUrl = redactFeedUrl(feedUrl);
    try {
      let filter = '';
      let searchFeedTitle = 'Academic Search Feed';

      if (/biorxiv\.org/i.test(redactedUrl)) {
        filter = 'prefix:10.1101';
        searchFeedTitle = 'bioRxiv Preprints';
      } else if (/medrxiv\.org/i.test(redactedUrl)) {
        filter = 'prefix:10.1101';
        searchFeedTitle = 'medRxiv Preprints';
      } else if (/mdpi\.com/i.test(redactedUrl)) {
        filter = 'prefix:10.3390';
        searchFeedTitle = 'MDPI Open Access';
      } else {
        try {
          const parsedUrl = new URL(redactedUrl);
          const domain = parsedUrl.hostname.replace(/^www\./, '');
          searchFeedTitle = `${domain} Feed`;
        } catch {
          searchFeedTitle = 'Academic Feed';
        }
      }

      const provider =
        this.crossRefProvider ?? new CrossRefProvider(this.httpClient);
      const items = await provider.searchRecentWorks(
        {
          ...(filter ? { filter } : { query: redactedUrl }),
          rows: 30,
        },
        AbortSignal.timeout(15000),
      );
      if (!Array.isArray(items) || items.length === 0) {
        throw new ExternalProviderException(
          'No articles found in fallback academic registry',
        );
      }

      const entries = items.map(
        (
          item: {
            title?: string | string[];
            DOI?: string;
            'container-title'?: string | string[];
            author?: Array<{ given?: string; family?: string; name?: string }>;
            published?: { 'date-parts'?: number[][] };
            created?: { 'date-parts'?: number[][] };
            URL?: string;
            link?: Array<{ 'content-type'?: string; URL?: string }>;
            abstract?: string;
            volume?: string;
            issue?: string;
            page?: string;
            subject?: string[];
            license?: Array<{ URL?: string }>;
          },
          idx: number,
        ) => {
          const rawTitle = Array.isArray(item.title)
            ? item.title[0]
            : item.title || 'Untitled Article';
          const doi = item.DOI || undefined;
          const journal = Array.isArray(item['container-title'])
            ? item['container-title'][0]
            : item['container-title'] || searchFeedTitle;
          const authors = Array.isArray(item.author)
            ? item.author.map(
                (a) =>
                  [a.given, a.family].filter(Boolean).join(' ') ||
                  a.name ||
                  'Author',
              )
            : [];
          const pubDateParts =
            item.published?.['date-parts']?.[0] ||
            item.created?.['date-parts']?.[0];
          const publishedDate = pubDateParts
            ? `${pubDateParts[0]}-${String(pubDateParts[1] || 1).padStart(2, '0')}-${String(pubDateParts[2] || 1).padStart(2, '0')}`
            : undefined;

          return {
            id: doi ? `doi:${doi}` : `search-item-${idx}`,
            title: rawTitle,
            url: item.URL || (doi ? `https://doi.org/${doi}` : undefined),
            pdfUrl:
              item.link?.find((l) => l['content-type'] === 'application/pdf')
                ?.URL || undefined,
            doi,
            authors,
            creators: authors.map((name: string, cIdx: number) =>
              parseCreatorString(name, cIdx, 'author'),
            ),
            abstract:
              item.abstract?.replace(/<[^>]+>/g, '').trim() || undefined,
            publicationTitle: journal,
            volume: item.volume || undefined,
            issue: item.issue || undefined,
            pages: item.page || undefined,
            publicationDate: publishedDate,
            year: pubDateParts ? pubDateParts[0] : undefined,
            keywords: Array.isArray(item.subject) ? item.subject : [],
            rights: item.license?.[0]?.URL || 'Open Access',
            itemType: 'journalArticle' as const,
          };
        },
      );

      return {
        format: 'rss2',
        feedTitle: searchFeedTitle,
        feedUrl,
        updatedAt: new Date().toISOString(),
        entries,
      };
    } catch (err: unknown) {
      this.logger.error(
        `Academic search fallback failed for ${redactedUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        `Failed to fetch feed and academic search fallback was unable to retrieve articles: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export interface DomainRateLimitConfig {
  minIntervalMs: number;
}

/**
 * Domain-Specific Continuous-Time GCRA (Generic Cell Rate Algorithm) Rate Limiter.
 *
 * Guarantees minimum spacing between consecutive outgoing requests to external
 * academic APIs using Theoretical Arrival Time (TAT):
 *   t_next = max(t_now, t_last + minIntervalMs)
 *   waitMs = t_next - t_now
 */
@Injectable()
export class DomainRateLimiterService {
  private readonly logger = new Logger(DomainRateLimiterService.name);

  private static readonly MAX_DOMAINS = 1000;
  private readonly lastExecutionMap = new Map<string, number>();

  private bypassDelayEnabled = false;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() options?: { bypassDelay?: boolean },
  ) {
    if (options?.bypassDelay !== undefined) {
      this.bypassDelayEnabled = Boolean(options.bypassDelay);
    }
  }

  public setBypassDelay(bypass: boolean): void {
    this.bypassDelayEnabled = Boolean(bypass);
  }

  public get bypassDelay(): boolean {
    return this.bypassDelayEnabled;
  }

  public set bypassDelay(bypass: boolean) {
    this.bypassDelayEnabled = Boolean(bypass);
  }

  private readonly domainConfigs: Record<string, DomainRateLimitConfig> = {
    // arXiv: strict 1 request per 3 seconds guideline
    'export.arxiv.org': { minIntervalMs: 3000 },
    'arxiv.org': { minIntervalMs: 3000 },
    arxiv: { minIntervalMs: 3000 },

    // PubMed / NCBI E-utilities: ~3 requests per second without API key
    'eutils.ncbi.nlm.nih.gov': { minIntervalMs: 350 },
    'api.ncbi.nlm.nih.gov': { minIntervalMs: 350 },
    pubmed: { minIntervalMs: 350 },

    // DBLP Computer Science Bibliography: ~4-5 requests per second
    'dblp.org': { minIntervalMs: 250 },
    'dblp.uni-trier.de': { minIntervalMs: 250 },
    dblp: { minIntervalMs: 250 },

    // Semantic Scholar API: ~5 requests per second
    'api.semanticscholar.org': { minIntervalMs: 200 },
    semanticscholar: { minIntervalMs: 200 },
    'semantic-scholar': { minIntervalMs: 200 },

    // CrossRef Polite Pool: 50 requests per second
    'api.crossref.org': { minIntervalMs: 50 },
    crossref: { minIntervalMs: 50 },

    // OpenAlex: 50 requests per second
    'api.openalex.org': { minIntervalMs: 50 },
    openalex: { minIntervalMs: 50 },
  };

  /**
   * Normalizes hostname or provider key to canonical lookup key.
   */
  public normalizeKey(domainOrKey: string): string {
    return domainOrKey
      .toLowerCase()
      .replace(/^(https?:\/\/)/i, '')
      .replace(/:\d+$/, '')
      .trim();
  }

  /**
   * Resolves rate limit configuration for domain or provider identifier.
   */
  public getConfig(domainOrKey: string): DomainRateLimitConfig {
    const key = this.normalizeKey(domainOrKey);
    return this.domainConfigs[key] || { minIntervalMs: 50 };
  }

  private setLastExecution(key: string, timestamp: number): void {
    if (this.lastExecutionMap.has(key)) {
      this.lastExecutionMap.delete(key);
    } else if (
      this.lastExecutionMap.size >= DomainRateLimiterService.MAX_DOMAINS
    ) {
      const oldestKey = this.lastExecutionMap.keys().next().value;
      if (oldestKey !== undefined) {
        this.lastExecutionMap.delete(oldestKey);
      }
    }
    this.lastExecutionMap.set(key, timestamp);
  }

  /**
   * Enforces inter-request spacing for the target domain or provider via GCRA Theoretical Arrival Time (TAT).
   * Resolves when the caller is safe to proceed.
   */
  public async acquire(
    domainOrKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.bypassDelayEnabled) return;
    if (signal?.aborted) {
      await this.sleep(0, signal);
    }

    const normalizedDomain = this.normalizeKey(domainOrKey);
    const config = this.getConfig(normalizedDomain);
    const minIntervalMs = config.minIntervalMs;

    const now = Date.now();
    const lastExec = this.lastExecutionMap.get(normalizedDomain) ?? 0;
    const nextExec = Math.max(now, lastExec + minIntervalMs);
    let waitMs = nextExec - now;
    this.setLastExecution(normalizedDomain, nextExec);

    // Multi-Pod Distributed Check: Synchronize with cluster via atomic Redis Lua GCRA script
    if (this.redis?.isReady && this.redis.isReady()) {
      try {
        const client = this.redis.getClient?.();
        if (client) {
          const redisKey = `library:ratelimit:${normalizedDomain}:last_exec`;
          const ttlMs = Math.max(minIntervalMs * 3, 5000);
          const luaScript = `
            local last = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
            local now = tonumber(ARGV[1])
            local time_arr = redis.call('TIME')
            if time_arr and #time_arr >= 2 then
              now = tonumber(time_arr[1]) * 1000 + math.floor(tonumber(time_arr[2]) / 1000)
            end
            local interval = tonumber(ARGV[2])
            local ttl = tonumber(ARGV[3])
            local next_exec = math.max(now, last + interval)
            redis.call('SET', KEYS[1], tostring(next_exec), 'PX', ttl)
            return next_exec - now
          `;
          if (typeof client.eval === 'function') {
            const evalRes = await client.eval(
              luaScript,
              1,
              redisKey,
              String(now),
              String(minIntervalMs),
              String(ttlMs),
            );
            const distWait = Math.max(0, Number(evalRes) || 0);
            if (distWait > waitMs) {
              waitMs = distWait;
              this.setLastExecution(normalizedDomain, now + waitMs);
            }
          } else {
            const redisLastExecStr = await client.get(redisKey);
            const redisLastExec = redisLastExecStr
              ? Number(redisLastExecStr)
              : 0;
            const distNextExec = Math.max(now, redisLastExec + minIntervalMs);
            const distWait = distNextExec - now;
            if (distWait > waitMs) {
              waitMs = distWait;
              this.setLastExecution(normalizedDomain, now + waitMs);
            }
            await client.set(
              redisKey,
              (now + waitMs).toString(),
              'PX',
              ttlMs,
            );
          }
        }
      } catch (redisErr) {
        // Non-blocking fallback to local TAT reservation
        this.logger.debug(
          `[DomainRateLimiter] Distributed rate-limit fallback: ${redisErr instanceof Error ? redisErr.message : String(redisErr)}`,
        );
      }
    }

    if (waitMs > 0) {
      this.logger.debug(
        `[DomainRateLimiter] Spacing request for "${normalizedDomain}" by ${waitMs}ms to comply with rate limits`,
      );
      try {
        await this.sleep(waitMs, signal);
      } catch (sleepErr) {
        if (signal?.aborted) {
          void this.refundSlot(normalizedDomain, minIntervalMs).catch(
            () => undefined,
          );
        }
        throw sleepErr;
      }
    }
  }

  private async refundSlot(
    normalizedDomain: string,
    intervalMs: number,
  ): Promise<void> {
    const client = this.redis?.getClient?.();
    if (!client) return;
    const redisKey = `library:ratelimit:${normalizedDomain}:last_exec`;
    const refundScript = `
      local last = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
      local interval = tonumber(ARGV[1])
      if last > 0 then
        local new_val = math.max(0, last - interval)
        redis.call('SET', KEYS[1], tostring(new_val), 'KEEPTTL')
      end
      return 1
    `;
    try {
      if (typeof client.eval === 'function') {
        await client.eval(refundScript, 1, redisKey, String(intervalMs));
      }
    } catch {
      // Non-fatal fallback
    }
  }

  /**
   * Helper execution wrapper.
   */
  public async schedule<T>(
    domainOrKey: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquire(domainOrKey, signal);
    return task();
  }

  /**
   * Configures rate limit for a specific domain (useful for tests or custom endpoints).
   */
  public setDomainConfig(domain: string, config: DomainRateLimitConfig): void {
    const key = this.normalizeKey(domain);
    this.domainConfigs[key] = config;
  }

  /**
   * Resets rate limiter state (useful in test teardown).
   */
  public reset(): void {
    this.lastExecutionMap.clear();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const getAbortError = () =>
        signal?.reason instanceof Error
          ? signal.reason
          : new Error(signal?.reason ? String(signal.reason) : 'Aborted');

      if (signal?.aborted) {
        return reject(getAbortError());
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(getAbortError());
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
