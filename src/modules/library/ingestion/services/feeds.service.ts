import { Injectable, Logger, NotFoundException, BadRequestException, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisCacheService, shouldRunWorkerConsumers } from '@/core';
import { LIBRARY_REDIS_KEYS, CircuitBreaker, ResilienceRegistryService } from '@/modules/library/core';
import { FeedRetrievalService, redactFeedUrl } from '@/modules/library/ingestion/services/feed-retrieval.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { FeedsRepository, type FeedSubscriptionRecord } from '@/modules/library/ingestion/repositories/feeds.repository';
import { libraryConfig } from '@/modules/library/core/config/library.config';

type FeedSubscriptionDto = FeedSubscriptionRecord;

@Injectable()
export class FeedsService {
  private readonly logger = new Logger(FeedsService.name);
  private readonly feedFetcher: {
    fetchAcademicFeed: FeedRetrievalService['fetchAcademicFeed'];
  };

  constructor(
    private readonly feedsRepo: FeedsRepository,
    urlCaptureOrFeedRetrieval: FeedRetrievalService,
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() feedRetrievalService?: FeedRetrievalService,
  ) {
    this.feedFetcher = feedRetrievalService ?? urlCaptureOrFeedRetrieval;
  }

  private async invalidateSubscriptionsCache(userId: string): Promise<void> {
    if (!this.cache) return;
    await this.cache
      .del(LIBRARY_REDIS_KEYS.feedSubscriptions(userId))
      .catch(() => undefined);
  }

  async getSubscriptions(userId: string): Promise<FeedSubscriptionDto[]> {
    return this.feedsRepo.findSubscriptionsByUser(userId);
  }

  async subscribe(
    userId: string,
    url: string,
    customTitle?: string,
    cleanupDays?: number,
    cleanupReadAfter?: number,
    cleanupUnreadAfter?: number,
  ): Promise<FeedSubscriptionDto> {
    const cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      throw new BadRequestException('A valid HTTP/HTTPS URL is required');
    }

    let feed = await this.feedsRepo.findFeedByUrl(cleanUrl);

    if (!feed) {
      const resolvedCustomTitle = customTitle?.trim();
      if (resolvedCustomTitle && resolvedCustomTitle !== cleanUrl) {
        // Fast-path: Client-Side Protocol Virtualizer already resolved the feed title
        feed = await this.feedsRepo.createFeed({ url: cleanUrl, title: resolvedCustomTitle, siteUrl: cleanUrl, description: null });
      } else {
        try {
          const fetched =
            await this.feedFetcher.fetchAcademicFeed(cleanUrl);
          feed = await this.feedsRepo.findFeedByUrl(cleanUrl);
          if (!feed) {
            feed = await this.feedsRepo.createFeed({
              url: cleanUrl,
              title: fetched.feedTitle || cleanUrl,
              siteUrl: fetched.feedUrl || null,
              description: null,
            });
          }
        } catch (err: unknown) {
          this.logger.warn(
            `Could not parse feed at ${cleanUrl} during subscribe: ${err}`,
          );
          feed = await this.feedsRepo.createFeed({
            url: cleanUrl,
            title: customTitle || cleanUrl,
          });
        }
      }
    }

    const sub = await this.feedsRepo.upsertSubscription({
      userId,
      feedId: feed.id,
      customTitle,
      cleanupDays,
      cleanupReadAfter,
      cleanupUnreadAfter,
    });
    await this.invalidateSubscriptionsCache(userId);
    return sub;
  }

  async unsubscribe(userId: string, feedId: string): Promise<void> {
    await this.feedsRepo.deleteSubscription(userId, feedId);
    await this.invalidateSubscriptionsCache(userId);
  }

  async updateSubscription(
    userId: string,
    feedId: string,
    data: {
      customTitle?: string;
      cleanupDays?: number;
      cleanupReadAfter?: number;
      cleanupUnreadAfter?: number;
      url?: string;
    },
  ): Promise<FeedSubscriptionDto> {
    const existing = await this.feedsRepo.findSubscription(userId, feedId);
    if (!existing) {
      throw new NotFoundException('Subscription not found');
    }

    let targetFeedId: string | undefined = undefined;
    if (data.url && data.url.trim() && data.url.trim() !== existing.feed.url) {
      const cleanUrl = data.url.trim();
      let feed = await this.feedsRepo.findFeedByUrl(cleanUrl);
      if (!feed) {
        const resolvedCustomTitle = data.customTitle?.trim();
        if (resolvedCustomTitle && resolvedCustomTitle !== cleanUrl) {
          feed = await this.feedsRepo.createFeed({ url: cleanUrl, title: resolvedCustomTitle, siteUrl: cleanUrl, description: null });
        } else {
          try {
            const fetched = await this.feedFetcher.fetchAcademicFeed(
              cleanUrl,
              true,
            );
            feed = await this.feedsRepo.findFeedByUrl(cleanUrl);
            if (!feed) {
              feed = await this.feedsRepo.createFeed({
                url: cleanUrl,
                title: data.customTitle || fetched.feedTitle || cleanUrl,
                siteUrl: fetched.siteUrl || fetched.feedUrl || null,
                description: fetched.description || null,
              });
            }
          } catch {
            feed = await this.feedsRepo.createFeed({
              url: cleanUrl,
              title: data.customTitle || cleanUrl,
            });
          }
        }
      }
      targetFeedId = feed.id;
    }

    const updated = await this.feedsRepo.updateSubscriptionById(existing.id, {
      customTitle: data.customTitle,
      cleanupDays: data.cleanupDays,
      cleanupReadAfter: data.cleanupReadAfter,
      cleanupUnreadAfter: data.cleanupUnreadAfter,
      feedId: targetFeedId,
    });
    await this.invalidateSubscriptionsCache(userId);
    return updated;
  }

  async getFeedItems(
    userId: string,
    feedId: string,
    options?: {
      readStatus?: 'read' | 'unread' | 'all';
      limit?: number;
      cursor?: string;
      page?: number;
      search?: string;
      forceRefresh?: boolean;
    },
  ) {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
    const readStatus = options?.readStatus ?? 'all';
    const sub = await this.feedsRepo.findSubscription(userId, feedId);
    if (!sub) {
      throw new NotFoundException('Feed subscription not found');
    }
    const resolvedFeedId = sub.feedId || feedId;

    if (options?.forceRefresh && sub.feed?.url) {
      try {
        await this.feedFetcher.fetchAcademicFeed(sub.feed.url, true);
      } catch (err: unknown) {
        this.logger.warn(
          `[FeedsService] Force refresh failed for feed "${sub.feed.url}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const items = await this.feedsRepo.findFeedItemsForUser({
      userId,
      feedId: resolvedFeedId,
      readStatus,
      limit: limit + 1,
      cursor: options?.cursor,
      page: options?.page,
      search: options?.search,
      cleanupReadAfter: sub.cleanupReadAfter,
      cleanupUnreadAfter: sub.cleanupUnreadAfter,
    });

    const queryLower = options?.search?.trim().toLowerCase() || '';
    const filteredItems = queryLower
      ? items.filter((it) => {
          const titleMatch = (it.title || '').toLowerCase().includes(queryLower);
          const abstractMatch = (it.abstract || '').toLowerCase().includes(queryLower);
          const doiMatch = (it.doi || '').toLowerCase().includes(queryLower);
          const arxivMatch = (it.arxivId || '').toLowerCase().includes(queryLower);
          const categoryMatch = (it.primaryCategory || '').toLowerCase().includes(queryLower);
          const authorsMatch = Array.isArray(it.authors)
            ? (
                it.authors as Array<
                  | string
                  | {
                      name?: string;
                      fullName?: string;
                      firstName?: string;
                      lastName?: string;
                    }
                >
              ).some((a) =>
                typeof a === 'string'
                  ? a.toLowerCase().includes(queryLower)
                  : [a.name, a.fullName, a.firstName, a.lastName].some((part) =>
                      (part || '').toLowerCase().includes(queryLower),
                    ),
              )
            : false;
          return (
            titleMatch ||
            abstractMatch ||
            doiMatch ||
            arxivMatch ||
            categoryMatch ||
            authorsMatch
          );
        })
      : items;

    const hasNextPage = filteredItems.length > limit;
    const pagedItems = hasNextPage
      ? filteredItems.slice(0, limit)
      : filteredItems;
    const nextCursor = hasNextPage
      ? (pagedItems[pagedItems.length - 1]?.id ?? null)
      : null;

    const mapped = pagedItems.map((it) => {
      const state = it.readStates?.[0] as
        | {
            readAt?: Date | null;
            isRead?: boolean;
            savedItemId?: string | null;
          }
        | undefined;
      return {
        id: it.id,
        feedId: it.feedId,
        guid: it.guid,
        title: it.title,
        url: it.url,
        pdfUrl: it.pdfUrl,
        doi: it.doi,
        arxivId: it.arxivId,
        primaryCategory: it.primaryCategory,
        authors: it.authors,
        abstract: it.abstract,
        license: it.license,
        comments: it.comments,
        metadata: (it as { metadata?: unknown }).metadata,
        publishedAt: it.publishedAt,
        isRead:
          typeof (it as { isRead?: boolean }).isRead === 'boolean'
            ? (it as { isRead: boolean }).isRead
            : Boolean(state?.isRead ?? state?.readAt),
        readAt:
          (it as { readAt?: Date | null }).readAt ?? state?.readAt ?? null,
        savedItemId:
          (it as { savedItemId?: string | null }).savedItemId ??
          state?.savedItemId ??
          null,
        isSaved:
          typeof (it as { isSaved?: boolean }).isSaved === 'boolean'
            ? (it as { isSaved: boolean }).isSaved
            : Boolean(state?.savedItemId),
      };
    });

    Object.defineProperty(mapped, '_paginationMeta', {
      value: { hasNextPage, nextCursor, limit },
      enumerable: false,
    });

    return mapped as typeof mapped & {
      _paginationMeta?: {
        hasNextPage: boolean;
        nextCursor: string | null;
        limit: number;
      };
    };
  }

  async markFeedAllRead(
    userId: string,
    feedId: string,
  ): Promise<{ markedCount: number }> {
    const sub = await this.feedsRepo.findSubscription(userId, feedId);
    if (!sub) {
      throw new NotFoundException('Feed subscription not found');
    }
    const resolvedFeedId = sub.feedId || feedId;
    const unreadItems = await this.feedsRepo.findFeedItemsForUser({
      userId,
      feedId: resolvedFeedId,
      readStatus: 'unread',
      limit: 500,
    });
    const ids = unreadItems.map((it) => it.id).filter(Boolean);
    if (ids.length > 0) {
      await this.feedsRepo.markManyItemsRead(userId, ids);
    }
    return { markedCount: ids.length };
  }

  async exportOpml(userId: string): Promise<string> {
    const subs = await this.getSubscriptions(userId);
    const escapeXml = (str: string) =>
      String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    const outlines = subs
      .map((s) => {
        const title = escapeXml(
          s.customTitle || s.feed?.title || s.feed?.url || 'Academic Feed',
        );
        const xmlUrl = escapeXml(s.feed?.url || '');
        const htmlUrl = s.feed?.siteUrl ? ` htmlUrl="${escapeXml(s.feed.siteUrl)}"` : '';
        return xmlUrl
          ? `      <outline type="rss" text="${title}" title="${title}" xmlUrl="${xmlUrl}"${htmlUrl}/>`
          : '';
      })
      .filter(Boolean)
      .join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0">',
      '  <head>',
      '    <title>Flux Academic Feeds</title>',
      `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
      '  </head>',
      '  <body>',
      '    <outline text="Academic Feeds" title="Academic Feeds">',
      outlines,
      '    </outline>',
      '  </body>',
      '</opml>',
    ].join('\n');
  }

  async importOpml(
    userId: string,
    opmlXml: string,
  ): Promise<{ importedCount: number; subscriptions: FeedSubscriptionDto[] }> {
    if (!opmlXml || typeof opmlXml !== 'string') {
      throw new BadRequestException('OPML XML content is required');
    }
    if (opmlXml.length > 1024 * 1024) {
      throw new BadRequestException('OPML XML content exceeds the 1MB limit');
    }
    if (/<!(?:doctype|entity)\b/i.test(opmlXml)) {
      throw new BadRequestException('OPML XML must not contain DOCTYPE or ENTITY declarations');
    }
    const outlineRegex = /<outline\b([^>]*?)\/?>/gi;
    const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const decodeXml = (val: string) =>
      val
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

    const candidates: Array<{ url: string; title?: string }> = [];
    const seenUrls = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = outlineRegex.exec(opmlXml)) !== null) {
      const attrsRaw = match[1] || '';
      const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(attrsRaw)) !== null) {
        const k = attrMatch[1].toLowerCase();
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        const v = decodeXml(attrMatch[2] ?? attrMatch[3] ?? '').trim();
        attrs[k] = v;
      }
      const xmlUrl = attrs.xmlurl || attrs.url;
      if (xmlUrl && /^https?:\/\//i.test(xmlUrl) && !seenUrls.has(xmlUrl)) {
        seenUrls.add(xmlUrl);
        candidates.push({
          url: xmlUrl,
          title: attrs.title || attrs.text || undefined,
        });
      }
    }

    const subscriptions: FeedSubscriptionDto[] = [];
    for (const candidate of candidates.slice(0, 50)) {
      try {
        const sub = await this.subscribe(userId, candidate.url, candidate.title);
        subscriptions.push(sub);
      } catch (err: unknown) {
        this.logger.warn(
          `[FeedsService] Skipping OPML feed "${candidate.url}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { importedCount: subscriptions.length, subscriptions };
  }

  async markItemRead(
    userId: string,
    itemId: string,
    isRead = true,
  ): Promise<void> {
    const canonicalId = await this.feedsRepo.resolveFeedItemUuid(
      itemId,
      userId,
    );
    if (!canonicalId) {
      this.logger.debug(
        `[FeedsService] Cannot record read state: FeedItem not found for identifier "${itemId}"`,
      );
      return;
    }

    await this.feedsRepo.setItemReadState(userId, canonicalId, isRead);
  }

  async markAllRead(userId: string, itemIds: string[]): Promise<void> {
    if (!itemIds || itemIds.length === 0) return;

    const resolvedIds = await this.feedsRepo.resolveFeedItemUuids(
      itemIds.slice(0, 200),
      userId,
    );

    if (resolvedIds.length === 0) return;

    await this.feedsRepo.markManyItemsRead(userId, resolvedIds);
  }
}

/**
 * FeedsEngine
 * Implements the Full 5 Resilience & Scalability Patterns:
 * 1. Bulkhead Pattern: Bounded concurrency pool (max 3 concurrent external feeds) to prevent network socket exhaustion
 * 2. Circuit Breaker Pattern: Automatically disables dead/failing feeds to protect workers from hanging
 * 3. Random Jitter: Desynchronizes polling schedules to eliminate Thundering Herd spikes
 * 4. Fallback Pattern: Fallback to Postgres articles or Crossref Search when blocked
 * 5. ETag / 304 Conditional Polling: Zero unnecessary bandwidth consumption
 * 6. Automated Retention Pruning: Zero database bloat over years of operation
 */
@Injectable()
export class FeedsEngine implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedsEngine.name);
  private pollingTimer: NodeJS.Timeout | null = null;
  private pruningTimer: NodeJS.Timeout | null = null;
  private readonly pendingTimeouts = new Set<NodeJS.Timeout>();
  private isShuttingDown = false;
  private isPollingActive = false;

  private readonly BULKHEAD_MAX_CONCURRENCY = 3;
  private readonly FAILURE_THRESHOLD = 3;
  private readonly RESET_TIMEOUT_MS = 12 * 60 * 60 * 1000;
  private readonly feedFetcher: {
    fetchAcademicFeed: FeedRetrievalService['fetchAcademicFeed'];
  };

  constructor(
    urlCaptureOrFeedRetrieval: FeedRetrievalService,
    @Optional() private readonly feedsRepo?: FeedsRepository,
    @Optional()
    private readonly resilienceRegistry: ResilienceRegistryService = new ResilienceRegistryService(),
    @Optional() feedRetrievalService?: FeedRetrievalService,
  ) {
    this.feedFetcher = feedRetrievalService ?? urlCaptureOrFeedRetrieval;
  }

  private scheduleTimeout(fn: () => void, delayMs: number): NodeJS.Timeout {
    const handle = setTimeout(
      () => {
        this.pendingTimeouts.delete(handle);
        if (!this.isShuttingDown) {
          fn();
        }
      },
      Math.max(0, delayMs),
    );
    handle.unref?.();
    this.pendingTimeouts.add(handle);
    return handle;
  }

  onModuleInit(): void {
    this.isShuttingDown = false;
    if (libraryConfig().app.isTest || !shouldRunWorkerConsumers()) return;

    const initialJitterMs = Math.floor(20 * 1000 + Math.random() * 20 * 1000);
    this.scheduleTimeout(() => {
      this.pollAllFeeds().catch((err) => {
        this.logger.warn(
          `Initial feed polling cycle error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, initialJitterMs);

    const basePollIntervalMs = 2 * 60 * 60 * 1000;
    this.pollingTimer = setInterval(() => {
      if (this.isShuttingDown) return;
      const jitter = Math.floor(Math.random() * 0.2 * basePollIntervalMs);
      this.scheduleTimeout(() => {
        this.pollAllFeeds().catch((err) => {
          this.logger.warn(
            `Scheduled feed polling error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, jitter);
    }, basePollIntervalMs);
    this.pollingTimer.unref?.();

    const pruneIntervalMs = 24 * 60 * 60 * 1000;
    this.scheduleTimeout(
      () => {
        this.pruneOldFeedArticles().catch((err) => {
          this.logger.warn(
            `Initial feed pruning error: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      2 * 60 * 1000,
    );

    this.pruningTimer = setInterval(() => {
      if (this.isShuttingDown) return;
      this.pruneOldFeedArticles().catch((err) => {
        this.logger.warn(
          `Daily feed retention pruning error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, pruneIntervalMs);
    this.pruningTimer.unref?.();

    this.logger.log(
      'FeedsEngine initialized with Bulkhead (concurrency: 3), Circuit Breaker, Random Jitter (2h) and Retention Pruning (24h).',
    );
  }

  onModuleDestroy(): void {
    this.isShuttingDown = true;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.pruningTimer) {
      clearInterval(this.pruningTimer);
      this.pruningTimer = null;
    }
    for (const handle of this.pendingTimeouts) {
      clearTimeout(handle);
    }
    this.pendingTimeouts.clear();
  }

  public get circuitBreakers(): Map<string, CircuitBreaker> {
    return this.resilienceRegistry.getBreakersByPrefix('feed:');
  }

  private getBreaker(feedUrl: string): CircuitBreaker {
    return this.resilienceRegistry.getCircuitBreaker(`feed:${feedUrl}`, {
      failureThreshold: this.FAILURE_THRESHOLD,
      resetTimeoutMs: this.RESET_TIMEOUT_MS,
    });
  }

  canExecute(feedUrl: string): boolean {
    return this.getBreaker(feedUrl).canExecute();
  }

  recordSuccess(feedUrl: string): void {
    this.getBreaker(feedUrl).recordSuccess();
  }

  recordFailure(feedUrl: string, reason: string): void {
    const breaker = this.getBreaker(feedUrl);
    const wasOpen = breaker.isOpen;
    breaker.recordFailure(true);
    if (!wasOpen && breaker.isOpen) {
      this.logger.warn(
        `🚨 Circuit Breaker TRIPPED for "${redactFeedUrl(feedUrl)}" (${breaker.getFailures()} consecutive failures: ${reason}). Silencing for 12 hours to protect worker threads.`,
      );
    }
  }

  async pollAllFeeds(): Promise<void> {
    if (
      !this.feedsRepo?.isAvailable ||
      this.isPollingActive ||
      this.isShuttingDown
    ) {
      return;
    }
    this.isPollingActive = true;

    try {
      const activeFeeds = await this.feedsRepo.findActiveFeedsForPolling(100);
      if (activeFeeds.length === 0 || this.isShuttingDown) return;

      this.logger.log(
        `Starting background feed refresh for ${activeFeeds.length} active feeds (Bulkhead limit: ${this.BULKHEAD_MAX_CONCURRENCY})...`,
      );

      for (
        let i = 0;
        i < activeFeeds.length;
        i += this.BULKHEAD_MAX_CONCURRENCY
      ) {
        if (this.isShuttingDown) break;
        const chunk = activeFeeds.slice(i, i + this.BULKHEAD_MAX_CONCURRENCY);

        await Promise.all(
          chunk.map(async (feed) => {
            if (this.isShuttingDown) return;
            if (!this.canExecute(feed.url)) {
              this.logger.debug(
                `Skipping feed "${redactFeedUrl(feed.url)}" — Circuit Breaker is OPEN.`,
              );
              return;
            }

            try {
              await this.feedFetcher.fetchAcademicFeed(feed.url, false);
              this.recordSuccess(feed.url);
              await this.feedsRepo?.markFeedPollSuccess(feed.id);
            } catch (fetchErr: unknown) {
              const errMsg =
                fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
              this.logger.warn(
                `Failed background fetch for feed "${redactFeedUrl(feed.url)}": ${errMsg}`,
              );
              this.recordFailure(feed.url, errMsg);
              await this.feedsRepo?.markFeedPollFailure(feed.id);
            }
          }),
        );

        if (this.isShuttingDown) break;
        const jitterDelay = 3000 + Math.floor(Math.random() * 1000);
        await new Promise<void>((resolve) => {
          this.scheduleTimeout(resolve, jitterDelay);
        });
      }
    } finally {
      this.isPollingActive = false;
    }
  }

  async pruneOldFeedArticles(
    defaultRetentionDays = 60,
    systemHardCapDays = 180,
  ): Promise<number> {
    if (!this.feedsRepo?.isAvailable || this.isShuttingDown) return 0;

    try {
      const feeds = await this.feedsRepo.findFeedsWithRetentionPreferences();
      if (feeds.length === 0 || this.isShuttingDown) return 0;

      let totalPurged = 0;
      const now = Date.now();
      const hardCapDate = new Date(
        now - systemHardCapDays * 24 * 60 * 60 * 1000,
      );

      for (const feed of feeds) {
        if (this.isShuttingDown) break;
        let readRetentionDays = defaultRetentionDays;
        let unreadRetentionDays = defaultRetentionDays;

        if (feed.subscriptions.length > 0) {
          const readPrefs = feed.subscriptions.map(
            (s) => s.cleanupReadAfter ?? s.cleanupUnreadAfter,
          );
          const unreadPrefs = feed.subscriptions.map(
            (s) => s.cleanupUnreadAfter,
          );
          readRetentionDays = readPrefs.some((days) => days <= 0)
            ? systemHardCapDays
            : Math.min(Math.max(...readPrefs), systemHardCapDays);
          unreadRetentionDays = unreadPrefs.some((days) => days <= 0)
            ? systemHardCapDays
            : Math.min(Math.max(...unreadPrefs), systemHardCapDays);
        }

        const subscriberUserIds = feed.subscriptions
          .map((s) => (s as { userId?: string; createdById?: string; spaceId?: string }).userId ?? (s as { createdById?: string }).createdById ?? (s as { spaceId?: string }).spaceId)
          .filter((uid): uid is string => typeof uid === 'string' && Boolean(uid));

        const readCutoffDate = new Date(
          now - readRetentionDays * 24 * 60 * 60 * 1000,
        );
        const unreadCutoffDate = new Date(
          now - unreadRetentionDays * 24 * 60 * 60 * 1000,
        );
        const [purgedRead, purgedUnread, purgedHardCap] = await Promise.all([
          this.feedsRepo.deleteFeedItemsOlderThan(
            readCutoffDate,
            feed.id,
            'read',
            subscriberUserIds,
          ),
          this.feedsRepo.deleteFeedItemsOlderThan(
            unreadCutoffDate,
            feed.id,
            'unread',
            subscriberUserIds,
          ),
          this.feedsRepo.deleteFeedItemsOlderThan(hardCapDate, feed.id),
        ]);
        totalPurged += purgedRead + purgedUnread + purgedHardCap;
      }

      if (totalPurged > 0) {
        this.logger.log(
          `Feed Retention Pruner: Safely purged ${totalPurged} feed items based on subscriber preferences.`,
        );
      }
      return totalPurged;
    } catch (err: unknown) {
      this.logger.warn(
        `Retention pruning failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
