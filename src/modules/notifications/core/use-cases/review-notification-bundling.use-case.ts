/**
 * notifications/core/use-cases/review-notification-bundling.use-case.ts
 *
 * Application service for review-notification bundling: lists pending
 * bundles from real unread notifications, flushes them into persisted digests
 * (marking source notifications read), and manages per-user settings.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationRepositoryPort,
  NOTIFICATION_REPOSITORY_PORT,
} from '../ports/notification-repository.port';
import { ReviewBundleStorePort } from '../ports/review-bundle-store.port';
import {
  buildDigest,
  buildPendingBundles,
  isReviewNotification,
  PendingBundle,
  ReviewBundlingSettings,
  ReviewDigest,
  toBundledItem,
} from '../domain/value-objects/review-bundle';

const SCAN_LIMIT = 500;

@Injectable()
export class ReviewNotificationBundlingUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repo: INotificationRepositoryPort,
    private readonly store: ReviewBundleStorePort,
  ) {}

  private async unreadReview(userId: string, projectId?: string) {
    const list = await this.repo.findByUser(userId, {
      isRead: false,
      limit: SCAN_LIMIT,
    });
    return list.filter(
      (n) =>
        isReviewNotification(n) && (!projectId || n.projectId === projectId),
    );
  }

  async getPendingBundles(userId: string): Promise<PendingBundle[]> {
    const settings = await this.store.getSettings(userId);
    if (!settings.enabled) return [];
    return buildPendingBundles(
      userId,
      await this.unreadReview(userId),
      settings,
    );
  }

  /**
   * Collapses pending review notifications (optionally one project) into a
   * digest, persists it, and marks the bundled notifications as read.
   * Returns null when nothing is pending.
   */
  async flush(userId: string, projectId?: string): Promise<ReviewDigest | null> {
    const settings = await this.store.getSettings(userId);
    const pending = await this.unreadReview(userId, projectId);
    if (pending.length === 0) return null;
    const digest = buildDigest(
      userId,
      pending
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toBundledItem),
      settings.windowMinutes,
      projectId,
    );
    await this.store.appendDigest(userId, digest);
    for (const n of pending) {
      await this.repo.markAsRead(n.id, userId);
    }
    return digest;
  }

  /** Flushes every bundle whose window has elapsed. */
  async flushDue(userId: string): Promise<ReviewDigest[]> {
    const due = (await this.getPendingBundles(userId)).filter(
      (b) => b.remainingSeconds === 0,
    );
    const out: ReviewDigest[] = [];
    for (const b of due) {
      const d = await this.flush(userId, b.bundle.projectId);
      if (d) out.push(d);
    }
    return out;
  }

  listDigests(userId: string, limit = 20): Promise<ReviewDigest[]> {
    return this.store.listDigests(userId, limit);
  }

  getSettings(userId: string): Promise<ReviewBundlingSettings> {
    return this.store.getSettings(userId);
  }

  async updateSettings(
    userId: string,
    patch: Partial<ReviewBundlingSettings>,
  ): Promise<ReviewBundlingSettings> {
    const current = await this.store.getSettings(userId);
    return this.store.saveSettings(userId, { ...current, ...patch });
  }
}
