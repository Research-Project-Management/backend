import { NotificationEntity } from '@/modules/notifications/core/domain/entities/notification.entity';
import {
  buildPendingBundles,
  buildDigest,
  toBundledItem,
  normalizeSettings,
  ReviewBundlingSettings,
  ReviewDigest,
} from '@/modules/notifications/core/domain/value-objects/review-bundle';
import { ReviewNotificationBundlingUseCase } from '@/modules/notifications/core/use-cases/review-notification-bundling.use-case';
import { ReviewBundleStorePort } from '@/modules/notifications/core/ports/review-bundle-store.port';
import { ReviewBundleFlushScheduler } from '@/modules/notifications/core/adapters/scheduling/review-bundle-flush.scheduler';

describe('ReviewBundleFlushScheduler', () => {
  it('flushes due bundles for candidate users only when lock acquired', async () => {
    const findMany = jest.fn(async () => [{ userId: 'u1' }, { userId: 'u2' }]);
    const mkPrisma = (locked: boolean): any => ({
      manuscriptNotification: { findMany },
      $transaction: (fn: any) => fn({ $queryRaw: async () => [{ locked }] }),
    });
    const bundling: any = {
      flushDue: jest.fn(async (u: string) => (u === 'u1' ? [{}, {}] : [])),
    };
    expect(
      await new ReviewBundleFlushScheduler(mkPrisma(false), bundling).sweep(),
    ).toBe(0);
    expect(bundling.flushDue).not.toHaveBeenCalled();
    expect(
      await new ReviewBundleFlushScheduler(mkPrisma(true), bundling).sweep(),
    ).toBe(2);
    expect(bundling.flushDue).toHaveBeenCalledTimes(2);
  });
});

const mk = (
  id: string,
  type: any,
  minsAgo: number,
  projectId = 'p1',
  isRead = false,
) =>
  new NotificationEntity({
    id,
    userId: 'u1',
    templateKey: 'review',
    type,
    projectId,
    docId: 'd1',
    actorId: 'a1',
    messageOpts: { actorName: 'Ann', snippet: `msg ${id}` },
    isRead,
    createdAt: new Date(Date.now() - minsAgo * 60_000),
  });

describe('review bundle domain', () => {
  const settings: ReviewBundlingSettings = { enabled: true, windowMinutes: 10 };

  it('groups unread review notifications by project and computes countdown', () => {
    const list = [
      mk('1', 'mention', 4),
      mk('2', 'comment_reply', 2),
      mk('3', 'mention', 1, 'p2'),
      mk('4', 'project_invite', 1),
      mk('5', 'mention', 1, 'p1', true),
    ];
    const bundles = buildPendingBundles('u1', list, settings);
    expect(bundles).toHaveLength(2);
    const p1 = bundles.find((b) => b.bundle.projectId === 'p1')!;
    expect(p1.itemCount).toBe(2);
    expect(p1.remainingSeconds).toBeGreaterThan(5 * 60);
    expect(p1.remainingSeconds).toBeLessThanOrEqual(6 * 60);
  });

  it('builds digest counts and summary', () => {
    const d = buildDigest(
      'u1',
      [mk('1', 'mention', 1), mk('2', 'comment_reply', 1)].map(toBundledItem),
      10,
      'p1',
    );
    expect(d.mentionCount).toBe(1);
    expect(d.replyCount).toBe(1);
    expect(d.summary).toBe('1 mention, 1 reply from 1 collaborator');
  });

  it('normalizes settings', () => {
    expect(normalizeSettings({ enabled: false, windowMinutes: 0 })).toEqual({
      enabled: false,
      windowMinutes: 10,
    });
  });
});

describe('ReviewNotificationBundlingUseCase', () => {
  it('flush persists digest and marks notifications read', async () => {
    const items = [mk('1', 'mention', 1), mk('2', 'mention', 1, 'p2')];
    const repo: any = {
      findByUser: jest.fn(async () => items),
      markAsRead: jest.fn(async () => true),
    };
    const digests: ReviewDigest[] = [];
    const store: ReviewBundleStorePort = {
      getSettings: async () => ({ enabled: true, windowMinutes: 10 }),
      saveSettings: async (_u, s) => s,
      appendDigest: async (_u, d) => void digests.push(d),
      listDigests: async () => digests,
    };
    const uc = new ReviewNotificationBundlingUseCase(repo, store);
    const d = await uc.flush('u1', 'p1');
    expect(d?.itemCount).toBe(1);
    expect(repo.markAsRead).toHaveBeenCalledWith('1', 'u1');
    expect(repo.markAsRead).toHaveBeenCalledTimes(1);
    expect(await uc.listDigests('u1')).toHaveLength(1);
    expect(await uc.flush('u1', 'nope')).toBeNull();
  });
});
