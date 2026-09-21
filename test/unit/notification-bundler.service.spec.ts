import { NotificationBundlerService } from '@/modules/document/notification/notification-bundler.service';
import {
  BundledNotificationItem,
  NotificationBundle,
} from '@/modules/document/notification/types/notification-bundler.types';

describe('NotificationBundlerService', () => {
  let service: NotificationBundlerService;
  let mockGateway: { broadcastRoomEvent: jest.Mock };

  beforeEach(() => {
    mockGateway = {
      broadcastRoomEvent: jest.fn(),
    };
    // Initialize service without redis to test in-memory fallback
    service = new NotificationBundlerService(
      undefined,
      mockGateway as any,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('User Settings', () => {
    it('should return default settings (10-minute window, enabled: true)', async () => {
      const settings = await service.getUserSettings('user-1');
      expect(settings).toEqual({
        enabled: true,
        windowMinutes: 10,
      });
    });

    it('should update user settings', async () => {
      const updated = await service.updateUserSettings('user-1', {
        windowMinutes: 5,
        enabled: false,
      });
      expect(updated.windowMinutes).toBe(5);
      expect(updated.enabled).toBe(false);

      const fetched = await service.getUserSettings('user-1');
      expect(fetched.windowMinutes).toBe(5);
      expect(fetched.enabled).toBe(false);
    });
  });

  describe('Digest Generation Algorithm', () => {
    it('should summarize single author with comments correctly', () => {
      const bundle: NotificationBundle = {
        recipientId: 'author-1',
        projectId: 'proj-1',
        createdAt: new Date().toISOString(),
        flushAt: new Date(Date.now() + 600000).toISOString(),
        items: [
          {
            id: 'item-1',
            type: 'comment',
            authorId: 'reviewer-alice',
            authorName: 'Alice',
            pageId: 'page-1',
            pageTitle: 'main.tex',
            contentSnippet: 'Please fix citation style',
            timestamp: new Date().toISOString(),
          },
          {
            id: 'item-2',
            type: 'comment',
            authorId: 'reviewer-alice',
            authorName: 'Alice',
            pageId: 'page-1',
            pageTitle: 'main.tex',
            contentSnippet: 'Add bibliography here',
            timestamp: new Date().toISOString(),
          },
        ],
      };

      const digest = service.generateDigest(bundle, 10);
      expect(digest.recipientId).toBe('author-1');
      expect(digest.itemCount).toBe(2);
      expect(digest.commentCount).toBe(2);
      expect(digest.mentionCount).toBe(0);
      expect(digest.authorSummaries.length).toBe(1);
      expect(digest.authorSummaries[0].authorName).toBe('Alice');
      expect(digest.authorSummaries[0].commentCount).toBe(2);
      expect(digest.summary).toBe('Alice left 2 comments in "main.tex"');
    });

    it('should summarize multiple authors with mixed events correctly', () => {
      const bundle: NotificationBundle = {
        recipientId: 'author-1',
        projectId: 'proj-1',
        createdAt: new Date().toISOString(),
        flushAt: new Date(Date.now() + 600000).toISOString(),
        items: [
          {
            id: 'item-1',
            type: 'mention',
            authorId: 'user-alice',
            authorName: 'Alice',
            pageId: 'page-1',
            pageTitle: 'chapter1.tex',
            contentSnippet: '@[Bob] check this out',
            timestamp: new Date().toISOString(),
          },
          {
            id: 'item-2',
            type: 'reply',
            authorId: 'user-bob',
            authorName: 'Bob',
            pageId: 'page-1',
            pageTitle: 'chapter1.tex',
            contentSnippet: 'Looks great!',
            timestamp: new Date().toISOString(),
          },
          {
            id: 'item-3',
            type: 'suggestion',
            authorId: 'user-charlie',
            authorName: 'Charlie',
            pageId: 'page-1',
            pageTitle: 'chapter1.tex',
            contentSnippet: 'change to eq. 1',
            timestamp: new Date().toISOString(),
          },
        ],
      };

      const digest = service.generateDigest(bundle, 10);
      expect(digest.itemCount).toBe(3);
      expect(digest.mentionCount).toBe(1);
      expect(digest.replyCount).toBe(1);
      expect(digest.suggestionCount).toBe(1);
      expect(digest.authorSummaries.length).toBe(3);
      expect(digest.summary).toContain('Alice and 2 others left');
      expect(digest.summary).toContain('1 mention');
      expect(digest.summary).toContain('1 reply');
      expect(digest.summary).toContain('1 suggestion');
      expect(digest.summary).toContain('in "chapter1.tex"');
    });
  });

  describe('Enqueue & Sliding Window', () => {
    it('should not enqueue event for author themselves', async () => {
      await service.enqueueEvent('user-1', {
        type: 'comment',
        authorId: 'user-1',
        authorName: 'Self',
        pageId: 'page-1',
        contentSnippet: 'Note to self',
      });

      const pending = await service.getPendingBundles('user-1');
      expect(pending).toHaveLength(0);
    });

    it('should buffer multiple events within sliding window', async () => {
      await service.enqueueEvent('recipient-1', {
        type: 'comment',
        authorId: 'author-alice',
        authorName: 'Alice',
        pageId: 'page-1',
        projectId: 'proj-1',
        contentSnippet: 'First comment',
      });

      await service.enqueueEvent('recipient-1', {
        type: 'suggestion',
        authorId: 'author-bob',
        authorName: 'Bob',
        pageId: 'page-1',
        projectId: 'proj-1',
        contentSnippet: 'Suggestion on line 10',
      });

      const pending = await service.getPendingBundles('recipient-1');
      expect(pending).toHaveLength(1);
      expect(pending[0].itemCount).toBe(2);
      expect(pending[0].remainingSeconds).toBeGreaterThan(0);
    });

    it('should immediately dispatch if bundling is disabled in user settings', async () => {
      await service.updateUserSettings('recipient-no-bundle', {
        enabled: false,
      });

      await service.enqueueEvent('recipient-no-bundle', {
        type: 'comment',
        authorId: 'author-alice',
        authorName: 'Alice',
        pageId: 'page-live',
        contentSnippet: 'Instant review comment',
      });

      // Bundles map should be empty
      const pending = await service.getPendingBundles('recipient-no-bundle');
      expect(pending).toHaveLength(0);

      // WebSocket event should be dispatched immediately
      expect(mockGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        'page-live',
        'notification:digest',
        expect.objectContaining({
          recipientId: 'recipient-no-bundle',
        }),
      );

      // Digest should be in history
      const history = await service.getDigestHistory('recipient-no-bundle');
      expect(history).toHaveLength(1);
      expect(history[0].itemCount).toBe(1);
    });
  });

  describe('Manual Flush & History', () => {
    it('should flush pending bundle immediately and notify client via WebSocket', async () => {
      await service.enqueueEvent('recipient-2', {
        type: 'mention',
        authorId: 'author-carol',
        authorName: 'Carol',
        pageId: 'page-room-1',
        projectId: 'proj-alpha',
        contentSnippet: 'Please verify lemma 2.1',
      });

      const flushed = await service.flushBundle('recipient-2', 'proj-alpha');
      expect(flushed).not.toBeNull();
      expect(flushed?.itemCount).toBe(1);
      expect(flushed?.summary).toContain('Carol');

      // Room event should have been emitted
      expect(mockGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        'page-room-1',
        'notification:digest',
        expect.objectContaining({
          recipientId: 'recipient-2',
          digest: expect.objectContaining({
            summary: expect.stringContaining('Carol'),
          }),
        }),
      );

      // Pending should now be empty
      const pendingAfter = await service.getPendingBundles('recipient-2');
      expect(pendingAfter).toHaveLength(0);

      // Archived in history
      const history = await service.getDigestHistory('recipient-2');
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(flushed?.id);
    });

    it('should return null when flushing a non-existent bundle', async () => {
      const result = await service.flushBundle('non-existent-user', 'any-scope');
      expect(result).toBeNull();
    });
  });
});
