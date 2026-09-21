import {
  Injectable,
  Logger,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import {
  BundledNotificationItem,
  NotificationBundle,
  NotificationDigest,
  NotificationDigestAuthorSummary,
  NotificationBundlingSettings,
  DEFAULT_BUNDLING_SETTINGS,
} from './types/notification-bundler.types';

@Injectable()
export class NotificationBundlerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationBundlerService.name);

  // In-memory fallback stores when Redis is unavailable or in unit tests
  private readonly memoryBundles = new Map<string, NotificationBundle>();
  private readonly memoryHistories = new Map<string, NotificationDigest[]>();
  private readonly memorySettings = new Map<string, NotificationBundlingSettings>();

  // Timers mapped by bundle key to trigger automatic flush
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly collaborationGateway?: CollaborationGateway,
  ) {}

  onModuleInit() {
    // Overleaf Parity: No continuous background polling. Notifications are dispatched in real-time or precision-scheduled per bundle.
  }

  onModuleDestroy() {
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
  }

  // ── 1. Settings ─────────────────────────────────────────────────────────────

  private settingsKey(userId: string): string {
    return `document:notify:settings:${userId}`;
  }

  async getUserSettings(userId: string): Promise<NotificationBundlingSettings> {
    if (this.redis) {
      try {
        const cached = await this.redis.get<NotificationBundlingSettings>(
          this.settingsKey(userId),
        );
        if (cached) return cached;
      } catch {
        // fallback
      }
    }
    return this.memorySettings.get(userId) || { ...DEFAULT_BUNDLING_SETTINGS };
  }

  async updateUserSettings(
    userId: string,
    settings: Partial<NotificationBundlingSettings>,
  ): Promise<NotificationBundlingSettings> {
    const current = await this.getUserSettings(userId);
    const updated: NotificationBundlingSettings = {
      ...current,
      ...settings,
    };

    if (this.redis) {
      try {
        await this.redis.set(this.settingsKey(userId), updated, 30 * 86400); // 30 days
      } catch {
        // fallback
      }
    }
    this.memorySettings.set(userId, updated);
    return updated;
  }

  // ── 2. Enqueue Events into 10-Minute Sliding Window ──────────────────────────

  private bundleKey(recipientId: string, scopeId: string): string {
    return `document:notify:bundle:${recipientId}:${scopeId}`;
  }

  private historyKey(recipientId: string): string {
    return `document:notify:history:${recipientId}`;
  }

  async enqueueEvent(
    recipientId: string,
    item: Omit<BundledNotificationItem, 'id' | 'timestamp'>,
  ): Promise<void> {
    // Never send notifications to the author themselves
    if (recipientId === item.authorId) return;

    const settings = await this.getUserSettings(recipientId);

    const fullItem: BundledNotificationItem = {
      ...item,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };

    // If bundling is disabled or window is 0, flush immediately
    if (!settings.enabled || settings.windowMinutes <= 0) {
      const immediateBundle: NotificationBundle = {
        recipientId,
        projectId: item.projectId,
        pageId: item.pageId,
        items: [fullItem],
        createdAt: fullItem.timestamp,
        flushAt: fullItem.timestamp,
      };
      await this.dispatchDigest(this.generateDigest(immediateBundle, 0));
      return;
    }

    const scopeId = item.projectId || item.pageId || 'global';
    const key = this.bundleKey(recipientId, scopeId);

    let bundle = await this.getRawBundle(key);
    const windowMs = settings.windowMinutes * 60 * 1000;
    const now = Date.now();

    if (!bundle) {
      bundle = {
        recipientId,
        projectId: item.projectId,
        pageId: item.pageId,
        items: [fullItem],
        createdAt: new Date(now).toISOString(),
        flushAt: new Date(now + windowMs).toISOString(),
      };

      // Set timeout for auto-flush
      this.scheduleTimer(key, recipientId, scopeId, windowMs);
    } else {
      bundle.items.push(fullItem);
      // Keep existing flushAt or slide window bounded to max 2x window
    }

    await this.saveRawBundle(key, bundle, settings.windowMinutes);
    this.logger.debug(
      `Enqueued ${item.type} notification for user ${recipientId} in bundle ${key} (total: ${bundle.items.length})`,
    );
  }

  private scheduleTimer(
    key: string,
    recipientId: string,
    scopeId: string,
    delayMs: number,
  ) {
    if (this.flushTimers.has(key)) {
      clearTimeout(this.flushTimers.get(key)!);
    }

    const timer = setTimeout(() => {
      this.flushBundle(recipientId, scopeId).catch((err) => {
        this.logger.warn(`Failed to auto-flush bundle ${key}: ${err.message}`);
      });
      this.flushTimers.delete(key);
    }, delayMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    this.flushTimers.set(key, timer);
  }

  // ── 3. Digest Aggregation Algorithm ──────────────────────────────────────────

  generateDigest(
    bundle: NotificationBundle,
    windowMinutes = 10,
  ): NotificationDigest {
    const { recipientId, projectId, items } = bundle;

    let mentionCount = 0;
    let commentCount = 0;
    let replyCount = 0;
    let suggestionCount = 0;

    const authorMap = new Map<string, NotificationDigestAuthorSummary>();

    for (const item of items) {
      if (item.type === 'mention') mentionCount++;
      else if (item.type === 'comment') commentCount++;
      else if (item.type === 'reply') replyCount++;
      else if (item.type === 'suggestion') suggestionCount++;

      const existing = authorMap.get(item.authorId) || {
        authorId: item.authorId,
        authorName: item.authorName,
        mentionCount: 0,
        commentCount: 0,
        replyCount: 0,
        suggestionCount: 0,
      };

      if (item.type === 'mention') existing.mentionCount++;
      else if (item.type === 'comment') existing.commentCount++;
      else if (item.type === 'reply') existing.replyCount++;
      else if (item.type === 'suggestion') existing.suggestionCount++;

      authorMap.set(item.authorId, existing);
    }

    const authorSummaries = Array.from(authorMap.values());
    const primaryAuthor = authorSummaries[0];
    const otherAuthorsCount = authorSummaries.length - 1;

    // Human-readable summary generation
    let summary = '';
    const actions: string[] = [];
    if (mentionCount > 0) {
      actions.push(`${mentionCount} mention${mentionCount > 1 ? 's' : ''}`);
    }
    if (commentCount > 0) {
      actions.push(`${commentCount} comment${commentCount > 1 ? 's' : ''}`);
    }
    if (replyCount > 0) {
      actions.push(`${replyCount} repl${replyCount > 1 ? 'ies' : 'y'}`);
    }
    if (suggestionCount > 0) {
      actions.push(
        `${suggestionCount} suggestion${suggestionCount > 1 ? 's' : ''}`,
      );
    }

    const actionText = actions.join(', ') || `${items.length} update(s)`;

    if (primaryAuthor) {
      if (otherAuthorsCount === 0) {
        summary = `${primaryAuthor.authorName} left ${actionText}`;
      } else {
        summary = `${primaryAuthor.authorName} and ${otherAuthorsCount} other${otherAuthorsCount > 1 ? 's' : ''} left ${actionText}`;
      }
    } else {
      summary = `${items.length} review updates`;
    }

    const docTitle = items.find((i) => i.pageTitle)?.pageTitle;
    if (docTitle) {
      summary += ` in "${docTitle}"`;
    }

    return {
      id: randomUUID(),
      recipientId,
      projectId,
      summary,
      itemCount: items.length,
      mentionCount,
      commentCount,
      replyCount,
      suggestionCount,
      authorSummaries,
      items,
      createdAt: new Date().toISOString(),
      windowMinutes,
    };
  }

  // ── 4. Flush Bundles & Broadcast ─────────────────────────────────────────────

  async flushBundle(
    recipientId: string,
    scopeId?: string,
  ): Promise<NotificationDigest | null> {
    const targetScope = scopeId || 'global';
    const key = this.bundleKey(recipientId, targetScope);

    const bundle = await this.getRawBundle(key);
    if (!bundle || bundle.items.length === 0) {
      return null;
    }

    // Cancel any running timer
    if (this.flushTimers.has(key)) {
      clearTimeout(this.flushTimers.get(key)!);
      this.flushTimers.delete(key);
    }

    const settings = await this.getUserSettings(recipientId);
    const digest = this.generateDigest(bundle, settings.windowMinutes);

    // Delete bundle from store
    await this.deleteRawBundle(key);

    // Dispatch digest via WebSocket and store in history
    await this.dispatchDigest(digest);

    this.logger.log(
      `Flushed notification digest for user ${recipientId}: "${digest.summary}" (${digest.itemCount} items)`,
    );

    return digest;
  }

  private async dispatchDigest(digest: NotificationDigest): Promise<void> {
    // 1. Store in user's digest history
    await this.archiveDigest(digest);

    // 2. Broadcast over WebSocket room if pageId is present
    const firstItem = digest.items[0];
    const pageId = firstItem?.pageId;

    if (pageId && this.collaborationGateway) {
      this.collaborationGateway.broadcastRoomEvent(
        pageId,
        'notification:digest',
        {
          recipientId: digest.recipientId,
          digest,
        },
      );
    }
  }

  private async archiveDigest(digest: NotificationDigest): Promise<void> {
    const key = this.historyKey(digest.recipientId);
    if (this.redis) {
      try {
        const history = (await this.redis.get<NotificationDigest[]>(key)) || [];
        history.unshift(digest);
        const trimmed = history.slice(0, 50); // keep last 50 digests
        await this.redis.set(key, trimmed, 30 * 86400);
        return;
      } catch {
        // fallback
      }
    }

    const memHistory = this.memoryHistories.get(digest.recipientId) || [];
    memHistory.unshift(digest);
    this.memoryHistories.set(digest.recipientId, memHistory.slice(0, 50));
  }

  async getDigestHistory(
    recipientId: string,
    limit = 20,
  ): Promise<NotificationDigest[]> {
    if (this.redis) {
      try {
        const history =
          (await this.redis.get<NotificationDigest[]>(
            this.historyKey(recipientId),
          )) || [];
        return history.slice(0, limit);
      } catch {
        // fallback
      }
    }

    const memHistory = this.memoryHistories.get(recipientId) || [];
    return memHistory.slice(0, limit);
  }

  async getPendingBundles(
    recipientId: string,
  ): Promise<
    Array<{
      bundle: NotificationBundle;
      itemCount: number;
      remainingSeconds: number;
    }>
  > {
    const result: Array<{
      bundle: NotificationBundle;
      itemCount: number;
      remainingSeconds: number;
    }> = [];

    // Check memory bundles
    for (const [key, bundle] of this.memoryBundles.entries()) {
      if (bundle.recipientId === recipientId) {
        const remaining = Math.max(
          0,
          Math.round((new Date(bundle.flushAt).getTime() - Date.now()) / 1000),
        );
        result.push({
          bundle,
          itemCount: bundle.items.length,
          remainingSeconds: remaining,
        });
      }
    }

    return result;
  }

  async flushAllExpiredBundles(): Promise<number> {
    let flushedCount = 0;
    const now = Date.now();

    for (const [key, bundle] of Array.from(this.memoryBundles.entries())) {
      if (new Date(bundle.flushAt).getTime() <= now) {
        const scopeId = bundle.projectId || bundle.pageId || 'global';
        await this.flushBundle(bundle.recipientId, scopeId);
        flushedCount++;
      }
    }

    return flushedCount;
  }

  // ── Raw Bundle Storage Helpers ───────────────────────────────────────────────

  private async getRawBundle(key: string): Promise<NotificationBundle | null> {
    if (this.redis) {
      try {
        const cached = await this.redis.get<NotificationBundle>(key);
        if (cached) return cached;
      } catch {
        // fallback
      }
    }
    return this.memoryBundles.get(key) || null;
  }

  private async saveRawBundle(
    key: string,
    bundle: NotificationBundle,
    windowMinutes: number,
  ): Promise<void> {
    const ttlSeconds = (windowMinutes + 10) * 60;
    if (this.redis) {
      try {
        await this.redis.set(key, bundle, ttlSeconds);
      } catch {
        // fallback
      }
    }
    this.memoryBundles.set(key, bundle);
  }

  private async deleteRawBundle(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch {
        // fallback
      }
    }
    this.memoryBundles.delete(key);
  }
}
