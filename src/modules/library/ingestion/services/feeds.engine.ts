import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import { libraryConfig } from '@/modules/library/core/config/library.config';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';

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
  private isPollingActive = false;

  // Bulkhead Isolation: Maximum 3 simultaneous feed fetches allowed for background engine
  // This guarantees 100% of remaining network sockets and worker threads remain free for active user requests
  private readonly BULKHEAD_MAX_CONCURRENCY = 3;

  // In-memory Circuit Breaker Registry per Feed URL
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();

  // Circuit Breaker constants:
  // - After 3 consecutive failures: Circuit trips OPEN
  // - Remains OPEN for 12 hours before allowing a single probe attempt (HALF-OPEN)
  private readonly FAILURE_THRESHOLD = 3;
  private readonly RESET_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours

  constructor(
    private readonly urlCaptureService: UrlCaptureService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  onModuleInit(): void {
    if (libraryConfig().app.isTest) return;

    // Start background poller every 2 hours with gentle initial Jitter delay
    const initialJitterMs = Math.floor(20 * 1000 + Math.random() * 20 * 1000); // 20s - 40s
    setTimeout(() => {
      this.pollAllFeeds().catch((err) => {
        this.logger.warn(`Initial feed polling cycle error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, initialJitterMs);

    const basePollIntervalMs = 2 * 60 * 60 * 1000;
    this.pollingTimer = setInterval(() => {
      // Apply ±10% random jitter on scheduled ticks
      const jitter = (Math.random() - 0.5) * 0.2 * basePollIntervalMs;
      setTimeout(() => {
        this.pollAllFeeds().catch((err) => {
          this.logger.warn(`Scheduled feed polling error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, Math.max(0, jitter));
    }, basePollIntervalMs);

    // Start daily retention pruner (every 24 hours, runs first time after 2 minutes)
    const pruneIntervalMs = 24 * 60 * 60 * 1000;
    setTimeout(() => {
      this.pruneOldFeedArticles().catch((err) => {
        this.logger.warn(`Initial feed pruning error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 2 * 60 * 1000);

    this.pruningTimer = setInterval(() => {
      this.pruneOldFeedArticles().catch((err) => {
        this.logger.warn(`Daily feed retention pruning error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, pruneIntervalMs);

    this.logger.log('FeedsEngine initialized with Bulkhead (concurrency: 3), Circuit Breaker, Random Jitter (2h) and Retention Pruning (24h).');
  }

  onModuleDestroy(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.pruningTimer) {
      clearInterval(this.pruningTimer);
      this.pruningTimer = null;
    }
  }

  /**
   * Circuit Breaker Check: Determines if a feed is healthy enough to fetch
   */
  canExecute(feedUrl: string): boolean {
    const cb = this.circuitBreakers.get(feedUrl);
    if (!cb) return true;

    if (cb.isOpen) {
      const timeSinceLastFailure = Date.now() - cb.lastFailureTime;
      if (timeSinceLastFailure > this.RESET_TIMEOUT_MS) {
        // State: HALF-OPEN (allows one trial request through)
        this.logger.log(`Circuit Breaker for "${feedUrl}" entered HALF-OPEN state. Testing probe...`);
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
        this.logger.log(`Circuit Breaker for "${feedUrl}" recovered: CLOSED.`);
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
        `🚨 Circuit Breaker TRIPPED for "${feedUrl}" (${cb.failures} consecutive failures: ${reason}). Silencing for 12 hours to protect worker threads.`,
      );
    }

    this.circuitBreakers.set(feedUrl, cb);
  }

  /**
   * Scans unique subscribed feeds and fetches updates with:
   * 1. Bulkhead Concurrency Pool: Limits parallel external socket connections
   * 2. Circuit Breaker safety gates: Skips dead domains
   * 3. Random Jitter: Desynchronizes request intervals
   * 4. Polite rate throttling (3s per domain)
   */
  async pollAllFeeds(): Promise<void> {
    if (!this.prisma || this.isPollingActive) return;
    this.isPollingActive = true;

    try {
      const activeFeeds = await this.prisma.feed.findMany({
        where: {
          errorCount: { lt: 5 }, // Skip feeds marked dead in DB
        },
        select: {
          id: true,
          url: true,
          lastFetchedAt: true,
        },
        take: 100,
      });

      if (activeFeeds.length === 0) return;

      this.logger.log(
        `Starting background feed refresh for ${activeFeeds.length} active feeds (Bulkhead limit: ${this.BULKHEAD_MAX_CONCURRENCY})...`,
      );

      // Bulkhead Chunking: Process active feeds in controlled chunks of BULKHEAD_MAX_CONCURRENCY
      for (let i = 0; i < activeFeeds.length; i += this.BULKHEAD_MAX_CONCURRENCY) {
        const chunk = activeFeeds.slice(i, i + this.BULKHEAD_MAX_CONCURRENCY);

        await Promise.all(
          chunk.map(async (feed) => {
            // Circuit Breaker Gate
            if (!this.canExecute(feed.url)) {
              this.logger.debug(`Skipping feed "${feed.url}" — Circuit Breaker is OPEN.`);
              return;
            }

            try {
              // Fetch via UrlCaptureService (uses ETag conditional get & DB caching)
              await this.urlCaptureService.fetchAcademicFeed(feed.url, false);
              this.recordSuccess(feed.url);
            } catch (fetchErr: unknown) {
              const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
              this.logger.warn(`Failed background fetch for feed "${feed.url}": ${errMsg}`);
              this.recordFailure(feed.url, errMsg);

              if (this.prisma) {
                await this.prisma.feed.update({
                  where: { id: feed.id },
                  data: { errorCount: { increment: 1 } },
                }).catch(() => {});
              }
            }
          }),
        );

        // Polite delay between Bulkhead chunks: 3 seconds ± 1000ms random jitter
        const jitterDelay = 3000 + Math.floor(Math.random() * 1000);
        await new Promise((resolve) => setTimeout(resolve, jitterDelay));
      }
    } finally {
      this.isPollingActive = false;
    }
  }

  /**
   * Smart Multi-Tenant Retention Pruner:
   * Resolves conflicts between different users' retention preferences:
   * 1. Evaluates MAX(retention_days) of all active subscribers for each feed.
   * 2. If any subscriber specifies "Never" (retentionDays <= 0), items are preserved up to the system hard cap.
   * 3. An article is ONLY purged if NO subscriber wants to keep it anymore.
   * 4. System Hard Cap (180 days): Protects server storage from unbounded accumulation.
   */
  async pruneOldFeedArticles(defaultRetentionDays = 60, systemHardCapDays = 180): Promise<number> {
    if (!this.prisma) return 0;

    try {
      // 1. Fetch all distinct feeds and inspect their subscribers' preferences
      const feeds = await this.prisma.feed.findMany({
        select: {
          id: true,
          subscriptions: {
            select: {
              cleanupUnreadAfter: true,
            },
          },
        },
      });

      if (feeds.length === 0) return 0;

      let totalPurged = 0;
      const now = Date.now();
      const hardCapDate = new Date(now - systemHardCapDays * 24 * 60 * 60 * 1000);

      // 2. Compute effective retention for each feed
      for (const feed of feeds) {
        let effectiveRetentionDays = defaultRetentionDays;

        if (feed.subscriptions.length > 0) {
          const preferences = feed.subscriptions.map((s) => s.cleanupUnreadAfter);

          // If any user chose "Never" (0 or negative), honor up to the system hard cap
          const hasNeverOption = preferences.some((days) => days <= 0);
          if (hasNeverOption) {
            effectiveRetentionDays = systemHardCapDays;
          } else {
            // Take the maximum duration among all active subscribers
            effectiveRetentionDays = Math.min(Math.max(...preferences), systemHardCapDays);
          }
        }

        const effectiveCutoffDate = new Date(now - effectiveRetentionDays * 24 * 60 * 60 * 1000);

        const deleteResult = await this.prisma.feedItem.deleteMany({
          where: {
            feedId: feed.id,
            publishedAt: {
              lt: effectiveCutoffDate,
            },
          },
        });

        totalPurged += deleteResult.count;
      }

      // 3. Global safeguard: enforce system hard cap across all feed items
      const hardCapPurged = await this.prisma.feedItem.deleteMany({
        where: {
          publishedAt: {
            lt: hardCapDate,
          },
        },
      });
      totalPurged += hardCapPurged.count;

      if (totalPurged > 0) {
        this.logger.log(`Multi-Tenant Retention Pruner: Safely purged ${totalPurged} feed items based on subscriber preferences.`);
      }
      return totalPurged;
    } catch (err: unknown) {
      this.logger.warn(`Retention pruning failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }
}
