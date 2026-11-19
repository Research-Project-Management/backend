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
  getBundleScopeInfo,
  isReviewNotification,
  PendingBundle,
  ReviewBundlingSettings,
  ReviewDigest,
  toBundledItem,
} from '../domain/value-objects/review-bundle';
import { NotificationEntity } from '../domain/entities/notification.entity';

const SCAN_LIMIT = 500;

export type FlushBundleTarget =
  string | { bundleKey?: string; spaceId?: string; pageId?: string };

@Injectable()
export class ReviewNotificationBundlingUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repo: INotificationRepositoryPort,
    private readonly store: ReviewBundleStorePort,
  ) {}

  private matchesTarget(
    n: NotificationEntity,
    target?: FlushBundleTarget,
  ): boolean {
    if (!target) return true;
    const info = getBundleScopeInfo(n);

    if (typeof target === 'string') {
      return (
        info.bundleKey === target ||
        info.spaceId === target ||
        n.projectId === target ||
        info.explicitPageId === target ||
        n.docId === target
      );
    }

    const { bundleKey, spaceId, pageId } = target;
    if (pageId) {
      const pageMatch =
        info.explicitPageId === pageId ||
        (!info.explicitPageId && n.docId === pageId);
      if (!pageMatch) return false;
      if (spaceId) {
        return (
          info.spaceId === spaceId || n.projectId === spaceId || !info.spaceId
        );
      }
      return true;
    }

    if (bundleKey) {
      if (
        info.bundleKey === bundleKey ||
        info.spaceId === bundleKey ||
        n.projectId === bundleKey ||
        info.explicitPageId === bundleKey
      ) {
        return true;
      }
    }

    if (spaceId) {
      return info.spaceId === spaceId || n.projectId === spaceId;
    }

    return true;
  }

  private async unreadReview(userId: string, target?: FlushBundleTarget) {
    const list = await this.repo.findByUser(userId, {
      isRead: false,
      limit: SCAN_LIMIT,
    });
    return list.filter(
      (n) => isReviewNotification(n) && this.matchesTarget(n, target),
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
   * Collapses pending review notifications (optionally scoped by space/page/bundleKey)
   * into a digest, persists it, and marks the bundled notifications as read.
   * Returns null when nothing is pending.
   */
  async flush(
    userId: string,
    target?: FlushBundleTarget,
  ): Promise<ReviewDigest | null> {
    const settings = await this.store.getSettings(userId);
    const pending = await this.unreadReview(userId, target);
    if (pending.length === 0) return null;

    const firstInfo = getBundleScopeInfo(pending[0]);
    const bundleKey =
      typeof target === 'string'
        ? target
        : target?.bundleKey || firstInfo.bundleKey || undefined;
    const spaceId =
      typeof target === 'object'
        ? (target.spaceId ?? firstInfo.spaceId)
        : firstInfo.spaceId;
    const pageId =
      typeof target === 'object'
        ? (target.pageId ?? firstInfo.explicitPageId)
        : firstInfo.explicitPageId;
    const legacyProjectId =
      typeof target === 'string' ? target : firstInfo.projectId;

    const digest = buildDigest(
      userId,
      pending
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toBundledItem),
      settings.windowMinutes,
      legacyProjectId,
      new Date(),
      { bundleKey, spaceId, pageId },
    );
    await this.store.appendDigest(userId, digest);

    const ids = pending.map((n) => n.id);
    if (typeof this.repo.markManyAsRead === 'function') {
      await this.repo.markManyAsRead(ids, userId);
    } else {
      await Promise.all(pending.map((n) => this.repo.markAsRead(n.id, userId)));
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
      const target: FlushBundleTarget | undefined =
        b.bundle.bundleKey || b.bundle.spaceId || b.bundle.pageId
          ? {
              bundleKey: b.bundle.bundleKey,
              spaceId: b.bundle.spaceId ?? undefined,
              pageId: b.bundle.pageId ?? undefined,
            }
          : b.bundle.projectId;
      const d = await this.flush(userId, target);
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
