import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { shouldRunWorkerConsumers } from '@/core';
import { libraryConfig } from '@/modules/library/core/config/library.config';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { redactFeedUrl } from '@/modules/library/ingestion/services/feed-retrieval.service';
import { FeedsRepository } from '@/modules/library/ingestion/repositories/feeds.repository';

export interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  isOpen: boolean;
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
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();
  private readonly FAILURE_THRESHOLD = 3;
  private readonly RESET_TIMEOUT_MS = 12 * 60 * 60 * 1000;

  constructor(
    private readonly urlCaptureService: UrlCaptureService,
    @Optional() private readonly feedsRepo?: FeedsRepository,
  ) {}

  private scheduleTimeout(fn: () => void, delayMs: number): NodeJS.Timeout {
    const handle = setTimeout(() => {
      this.pendingTimeouts.delete(handle);
      if (!this.isShuttingDown) {
        fn();
      }
    }, Math.max(0, delayMs));
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
    this.scheduleTimeout(() => {
      this.pruneOldFeedArticles().catch((err) => {
        this.logger.warn(
          `Initial feed pruning error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 2 * 60 * 1000);

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

  canExecute(feedUrl: string): boolean {
    const cb = this.circuitBreakers.get(feedUrl);
    if (!cb) return true;

    if (cb.isOpen) {
      const now = Date.now();
      const timeSinceLastFailure = now - cb.lastFailureTime;
      if (timeSinceLastFailure > this.RESET_TIMEOUT_MS) {
        cb.lastFailureTime = now;
        this.logger.log(
          `Circuit Breaker for "${redactFeedUrl(feedUrl)}" entered HALF-OPEN state. Testing single probe...`,
        );
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(feedUrl: string): void {
    const cb = this.circuitBreakers.get(feedUrl);
    if (cb) {
      if (cb.isOpen) {
        this.logger.log(
          `Circuit Breaker for "${redactFeedUrl(feedUrl)}" recovered: CLOSED.`,
        );
      }
      this.circuitBreakers.delete(feedUrl);
    }
  }

  recordFailure(feedUrl: string, reason: string): void {
    const cb = this.circuitBreakers.get(feedUrl) || {
      failures: 0,
      lastFailureTime: 0,
      isOpen: false,
    };

    cb.failures += 1;
    cb.lastFailureTime = Date.now();

    if (cb.failures >= this.FAILURE_THRESHOLD && !cb.isOpen) {
      cb.isOpen = true;
      this.logger.warn(
        `🚨 Circuit Breaker TRIPPED for "${redactFeedUrl(feedUrl)}" (${cb.failures} consecutive failures: ${reason}). Silencing for 12 hours to protect worker threads.`,
      );
    }

    this.circuitBreakers.set(feedUrl, cb);
  }

  async pollAllFeeds(): Promise<void> {
    if (!this.feedsRepo?.isAvailable || this.isPollingActive || this.isShuttingDown) {
      return;
    }
    this.isPollingActive = true;

    try {
      const activeFeeds = await this.feedsRepo.findActiveFeedsForPolling(100);
      if (activeFeeds.length === 0 || this.isShuttingDown) return;

      this.logger.log(
        `Starting background feed refresh for ${activeFeeds.length} active feeds (Bulkhead limit: ${this.BULKHEAD_MAX_CONCURRENCY})...`,
      );

      for (let i = 0; i < activeFeeds.length; i += this.BULKHEAD_MAX_CONCURRENCY) {
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
              await this.urlCaptureService.fetchAcademicFeed(feed.url, false);
              this.recordSuccess(feed.url);
              await this.feedsRepo?.markFeedPollSuccess(feed.id);
            } catch (fetchErr: unknown) {
              const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
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
      const hardCapDate = new Date(now - systemHardCapDays * 24 * 60 * 60 * 1000);

      for (const feed of feeds) {
        if (this.isShuttingDown) break;
        let effectiveRetentionDays = defaultRetentionDays;

        if (feed.subscriptions.length > 0) {
          const preferences = feed.subscriptions.flatMap((s) => [
            s.cleanupUnreadAfter,
            s.cleanupReadAfter ?? s.cleanupUnreadAfter,
          ]);
          const hasNeverOption = preferences.some((days) => days <= 0);
          if (hasNeverOption) {
            effectiveRetentionDays = systemHardCapDays;
          } else {
            effectiveRetentionDays = Math.min(Math.max(...preferences), systemHardCapDays);
          }
        }

        const effectiveCutoffDate = new Date(
          now - effectiveRetentionDays * 24 * 60 * 60 * 1000,
        );
        totalPurged += await this.feedsRepo.deleteFeedItemsOlderThan(
          effectiveCutoffDate,
          feed.id,
        );
      }

      if (!this.isShuttingDown) {
        totalPurged += await this.feedsRepo.deleteFeedItemsOlderThan(hardCapDate);
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
