/**
 * test/unit/manuscripts-notifications.service.spec.ts
 * Comprehensive Unit Test Suite for Manuscripts Notifications Subsystem
 * Testing Mention Parser, Notification Entity, Use Cases, Deduplication,
 * Expiration, Realtime Push, Service Facade & Overleaf-Parity Controllers.
 */

import {
  NotificationEntity,
  MentionToken,
  NotificationType,
  NotificationNotFoundException,
  InvalidNotificationException,
  RegexMentionParserAdapter,
  InMemoryNotificationAdapter,
  EventRealtimeNotifierAdapter,
  CreateNotificationUseCase,
  GetUserNotificationsUseCase,
  GetUnreadCountUseCase,
  MarkNotificationReadUseCase,
  MarkAllReadUseCase,
  DeleteNotificationUseCase,
  ParseAndNotifyMentionsUseCase,
  NotificationsService,
  NotificationsController,
  OverleafNotificationsParityController,
} from '@/modules/notifications';

describe('Global Notifications & Mentions Subsystem', () => {
  // =========================================================================
  // 1. DOMAIN LAYER: VALUE OBJECTS & ENTITIES
  // =========================================================================
  describe('Domain Value Objects & Entities', () => {
    describe('MentionToken', () => {
      it('should create mention token with correct attributes', () => {
        const token = MentionToken.create('@alice', 'alice', 5, false);
        expect(token.raw).toBe('@alice');
        expect(token.handle).toBe('alice');
        expect(token.index).toBe(5);
        expect(token.isEmail).toBe(false);
      });

      it('should identify email handles correctly', () => {
        const token = MentionToken.create('@user@uni.edu', 'user@uni.edu', 0, true);
        expect(token.isEmail).toBe(true);
      });
    });

    describe('NotificationType', () => {
      it('should validate valid notification types', () => {
        expect(NotificationType.isValid('mention')).toBe(true);
        expect(NotificationType.isValid('comment_reply')).toBe(true);
        expect(NotificationType.isValid('thread_resolved')).toBe(true);
        expect(NotificationType.isValid('project_invite')).toBe(true);
        expect(NotificationType.isValid('review_request')).toBe(true);
        expect(NotificationType.isValid('system')).toBe(true);
      });

      it('should reject invalid types', () => {
        expect(NotificationType.isValid('invalid_type')).toBe(false);
        expect(() => NotificationType.fromString('foo_bar')).toThrow();
      });
    });

    describe('NotificationEntity', () => {
      it('should instantiate with defaults and allow reading status toggles', () => {
        const entity = new NotificationEntity({
          id: 'notif-1',
          userId: 'user-1',
          templateKey: 'notification_comment_mention',
        });

        expect(entity.id).toBe('notif-1');
        expect(entity.userId).toBe('user-1');
        expect(entity.isRead).toBe(false);
        expect(entity.readAt).toBeNull();
        expect(entity.type).toBe('mention');

        entity.markAsRead();
        expect(entity.isRead).toBe(true);
        expect(entity.readAt).toBeInstanceOf(Date);

        entity.markAsUnread();
        expect(entity.isRead).toBe(false);
        expect(entity.readAt).toBeNull();
      });

      it('should accurately calculate isExpired', () => {
        const nonExpiring = new NotificationEntity({
          id: 'notif-2',
          userId: 'user-1',
          templateKey: 'test',
        });
        expect(nonExpiring.isExpired()).toBe(false);

        const futureExpiring = new NotificationEntity({
          id: 'notif-3',
          userId: 'user-1',
          templateKey: 'test',
          expiresAt: new Date(Date.now() + 60000),
        });
        expect(futureExpiring.isExpired()).toBe(false);

        const pastExpiring = new NotificationEntity({
          id: 'notif-4',
          userId: 'user-1',
          templateKey: 'test',
          expiresAt: new Date(Date.now() - 1000),
        });
        expect(pastExpiring.isExpired()).toBe(true);
      });

      it('should serialize to plain object cleanly', () => {
        const entity = new NotificationEntity({
          id: 'notif-5',
          userId: 'user-2',
          key: 'key-123',
          templateKey: 'notification_project_invite',
          messageOpts: { projectName: 'Quantum Computing' },
        });

        const plain = entity.toPlain();
        expect(plain.id).toBe('notif-5');
        expect(plain.key).toBe('key-123');
        expect(plain.messageOpts.projectName).toBe('Quantum Computing');
        expect(plain.isRead).toBe(false);
      });
    });

    describe('Domain Exceptions', () => {
      it('should provide appropriate status codes and messages', () => {
        const notFound = new NotificationNotFoundException('notif-999');
        expect(notFound.getStatus()).toBe(404);
        expect(notFound.message).toContain('notif-999');

        const badReq = new InvalidNotificationException('Missing field');
        expect(badReq.getStatus()).toBe(400);
        expect(badReq.message).toContain('Missing field');
      });
    });
  });

  // =========================================================================
  // 2. ADAPTERS LAYER: PARSER, STORAGE & REALTIME
  // =========================================================================
  describe('Adapters Layer', () => {
    describe('RegexMentionParserAdapter', () => {
      let parser: RegexMentionParserAdapter;

      beforeEach(() => {
        parser = new RegexMentionParserAdapter();
      });

      it('should extract single mention', () => {
        const tokens = parser.extractMentions('Hello @alice, check this out!');
        expect(tokens).toHaveLength(1);
        expect(tokens[0].handle).toBe('alice');
      });

      it('should extract multiple unique mentions and clean punctuation', () => {
        const text = 'Hey @bob! Did you see @charlie.brown, @alice? and @bob again?';
        const tokens = parser.extractMentions(text);

        expect(tokens).toHaveLength(3); // bob, charlie.brown, alice (deduplicated bob)
        expect(tokens.map((t) => t.handle)).toEqual(['bob', 'charlie.brown', 'alice']);
      });

      it('should extract mentions with email format', () => {
        const text = 'Assigning to @reviewer@mit.edu for evaluation.';
        const tokens = parser.extractMentions(text);
        expect(tokens).toHaveLength(1);
        expect(tokens[0].handle).toBe('reviewer@mit.edu');
        expect(tokens[0].isEmail).toBe(true);
      });

      it('should ignore emails when not preceded by mention @', () => {
        const text = 'My contact is researcher@oxford.ac.uk, please email me.';
        const tokens = parser.extractMentions(text);
        expect(tokens).toHaveLength(0);
      });

      it('should ignore single-letter tags', () => {
        const text = 'Variables @a and @x are defined.';
        const tokens = parser.extractMentions(text);
        expect(tokens).toHaveLength(0);
      });

      it('should return empty array on empty or non-string input', () => {
        expect(parser.extractMentions('')).toEqual([]);
        expect(parser.extractMentions(null as any)).toEqual([]);
      });
    });

    describe('InMemoryNotificationAdapter', () => {
      let repo: InMemoryNotificationAdapter;

      beforeEach(() => {
        repo = new InMemoryNotificationAdapter();
      });

      it('should save and find notification by ID', async () => {
        const notif = new NotificationEntity({
          id: 'n1',
          userId: 'u1',
          templateKey: 'tpl1',
        });
        await repo.save(notif);

        const found = await repo.findById('n1');
        expect(found).not.toBeNull();
        expect(found?.id).toBe('n1');
      });

      it('should find by idempotency key', async () => {
        const notif = new NotificationEntity({
          id: 'n2',
          userId: 'u1',
          key: 'unique-key-1',
          templateKey: 'tpl1',
        });
        await repo.save(notif);

        const found = await repo.findByKey('unique-key-1', 'u1');
        expect(found?.id).toBe('n2');

        const wrongUser = await repo.findByKey('unique-key-1', 'u2');
        expect(wrongUser).toBeNull();
      });

      it('should filter by isRead and pagination', async () => {
        const n1 = new NotificationEntity({ id: '1', userId: 'u1', templateKey: 't', isRead: false });
        const n2 = new NotificationEntity({ id: '2', userId: 'u1', templateKey: 't', isRead: true });
        const n3 = new NotificationEntity({ id: '3', userId: 'u1', templateKey: 't', isRead: false });
        await repo.save(n1);
        await repo.save(n2);
        await repo.save(n3);

        const unread = await repo.findByUser('u1', { isRead: false });
        expect(unread).toHaveLength(2);

        const paged = await repo.findByUser('u1', { limit: 1 });
        expect(paged).toHaveLength(1);
      });

      it('should count unread and exclude expired items', async () => {
        const active = new NotificationEntity({
          id: 'act',
          userId: 'u1',
          templateKey: 't',
          isRead: false,
        });
        const expired = new NotificationEntity({
          id: 'exp',
          userId: 'u1',
          templateKey: 't',
          isRead: false,
          expiresAt: new Date(Date.now() - 5000),
        });
        await repo.save(active);
        await repo.save(expired);

        const count = await repo.countUnread('u1');
        expect(count).toBe(1);
      });

      it('should mark all as read and delete by key', async () => {
        await repo.save(new NotificationEntity({ id: '1', userId: 'u1', key: 'k1', templateKey: 't' }));
        await repo.save(new NotificationEntity({ id: '2', userId: 'u1', key: 'k2', templateKey: 't' }));

        const updatedCount = await repo.markAllAsRead('u1');
        expect(updatedCount).toBe(2);

        const deleted = await repo.deleteByKey('k1', 'u1');
        expect(deleted).toBe(1);

        const remaining = await repo.findByUser('u1');
        expect(remaining).toHaveLength(1);
      });

      it('should delete expired notifications', async () => {
        await repo.save(new NotificationEntity({
          id: 'exp1',
          userId: 'u1',
          templateKey: 't',
          expiresAt: new Date(Date.now() - 10000),
        }));
        await repo.save(new NotificationEntity({
          id: 'valid1',
          userId: 'u1',
          templateKey: 't',
        }));

        const removed = await repo.deleteExpired();
        expect(removed).toBe(1);

        const valid = await repo.findById('valid1');
        expect(valid).not.toBeNull();
      });
    });

    describe('EventRealtimeNotifierAdapter', () => {
      it('should record and broadcast notification events', async () => {
        const notifier = new EventRealtimeNotifierAdapter();
        const notif = new NotificationEntity({
          id: 'n-realtime',
          userId: 'u-socket',
          templateKey: 'tpl',
        });

        await notifier.notifyUser('u-socket', notif, 5);
        expect(notifier.dispatchedEvents).toHaveLength(1);
        expect(notifier.dispatchedEvents[0].type).toBe('notification:new');
        expect(notifier.dispatchedEvents[0].payload.unreadCount).toBe(5);

        await notifier.broadcastUnreadCount('u-socket', 4);
        expect(notifier.dispatchedEvents).toHaveLength(2);
        expect(notifier.dispatchedEvents[1].type).toBe('notification:count');

        notifier.clearDispatchedEvents();
        expect(notifier.dispatchedEvents).toHaveLength(0);
      });
    });
  });

  // =========================================================================
  // 3. USE CASES LAYER
  // =========================================================================
  describe('Use Cases Layer', () => {
    let repo: InMemoryNotificationAdapter;
    let notifier: EventRealtimeNotifierAdapter;
    let parser: RegexMentionParserAdapter;

    let createUseCase: CreateNotificationUseCase;
    let getUserNotifsUseCase: GetUserNotificationsUseCase;
    let getUnreadCountUseCase: GetUnreadCountUseCase;
    let markReadUseCase: MarkNotificationReadUseCase;
    let markAllReadUseCase: MarkAllReadUseCase;
    let deleteUseCase: DeleteNotificationUseCase;
    let parseAndNotifyUseCase: ParseAndNotifyMentionsUseCase;

    beforeEach(() => {
      repo = new InMemoryNotificationAdapter();
      notifier = new EventRealtimeNotifierAdapter();
      parser = new RegexMentionParserAdapter();

      createUseCase = new CreateNotificationUseCase(repo, notifier);
      getUserNotifsUseCase = new GetUserNotificationsUseCase(repo);
      getUnreadCountUseCase = new GetUnreadCountUseCase(repo);
      markReadUseCase = new MarkNotificationReadUseCase(repo, notifier);
      markAllReadUseCase = new MarkAllReadUseCase(repo, notifier);
      deleteUseCase = new DeleteNotificationUseCase(repo, notifier);
      parseAndNotifyUseCase = new ParseAndNotifyMentionsUseCase(parser, createUseCase);
    });

    describe('CreateNotificationUseCase', () => {
      it('should create notification and trigger realtime alert', async () => {
        const notif = await createUseCase.execute({
          userId: 'user-alpha',
          templateKey: 'notification_project_invite',
          type: 'project_invite',
          messageOpts: { projectName: 'Paper 1' },
        });

        expect(notif.userId).toBe('user-alpha');
        expect(notif.type).toBe('project_invite');
        expect(notifier.dispatchedEvents).toHaveLength(1);
        expect(notifier.dispatchedEvents[0].userId).toBe('user-alpha');
      });

      it('should enforce idempotency when forceCreate is false', async () => {
        const first = await createUseCase.execute({
          userId: 'user-beta',
          key: 'idemp-1',
          templateKey: 'notification_comment_reply',
          forceCreate: false,
        });

        const second = await createUseCase.execute({
          userId: 'user-beta',
          key: 'idemp-1',
          templateKey: 'notification_comment_reply',
          forceCreate: false,
        });

        expect(first.id).toBe(second.id);
        const all = await repo.findByUser('user-beta');
        expect(all).toHaveLength(1);
      });

      it('should reject invalid commands', async () => {
        await expect(createUseCase.execute({
          userId: '',
          templateKey: 'test',
        })).rejects.toThrow(InvalidNotificationException);

        await expect(createUseCase.execute({
          userId: 'u1',
          templateKey: '',
        })).rejects.toThrow(InvalidNotificationException);

        await expect(createUseCase.execute({
          userId: 'u1',
          templateKey: 'test',
          type: 'invalid-type' as any,
        })).rejects.toThrow(InvalidNotificationException);

        await expect(createUseCase.execute({
          userId: 'u1',
          templateKey: 'test',
          expiresAt: 'not-a-date',
        })).rejects.toThrow(InvalidNotificationException);
      });
    });

    describe('MarkNotificationReadUseCase & MarkAllReadUseCase', () => {
      it('should mark single notification as read and broadcast count', async () => {
        const notif = await createUseCase.execute({
          userId: 'user-gamma',
          templateKey: 'test',
        });
        notifier.clearDispatchedEvents();

        const success = await markReadUseCase.execute(notif.id, 'user-gamma');
        expect(success).toBe(true);

        const updated = await repo.findById(notif.id);
        expect(updated?.isRead).toBe(true);
        expect(notifier.dispatchedEvents).toHaveLength(1);
      });

      it('should throw NotificationNotFoundException on unknown ID or wrong user', async () => {
        await expect(markReadUseCase.execute('unknown-id')).rejects.toThrow(
          NotificationNotFoundException
        );

        const notif = await createUseCase.execute({
          userId: 'user-owner',
          templateKey: 'test',
        });
        await expect(markReadUseCase.execute(notif.id, 'user-intruder')).rejects.toThrow(
          NotificationNotFoundException
        );
      });

      it('should mark all notifications as read', async () => {
        await createUseCase.execute({ userId: 'u-all', templateKey: 't1' });
        await createUseCase.execute({ userId: 'u-all', templateKey: 't2' });

        const count = await markAllReadUseCase.execute('u-all');
        expect(count).toBe(2);

        const unread = await getUnreadCountUseCase.execute('u-all');
        expect(unread).toBe(0);
      });
    });

    describe('DeleteNotificationUseCase', () => {
      it('should delete by ID and key', async () => {
        const n = await createUseCase.execute({
          userId: 'u-del',
          key: 'k-del',
          templateKey: 'test',
        });

        const deletedKey = await deleteUseCase.deleteByKey('k-del', 'u-del');
        expect(deletedKey).toBe(1);

        const after = await repo.findById(n.id);
        expect(after).toBeNull();
      });
    });

    describe('ParseAndNotifyMentionsUseCase', () => {
      it('should extract mentions, map collaborators, suppress self-mention, and dispatch notifications', async () => {
        const collaboratorMap: Record<string, string> = {
          alice: 'user-alice-id',
          bob: 'user-bob-id',
          charlie: 'user-charlie-id',
        };

        const result = await parseAndNotifyUseCase.execute({
          text: 'Great work! @Alice please review theorem 2, and @Bob check citations. Also tagging myself @charlie.',
          actorId: 'user-charlie-id', // author is charlie -> self-mention suppressed
          actorName: 'Charlie',
          projectId: 'proj-123',
          projectName: 'Neural Networks LaTeX',
          threadId: 'thread-99',
          collaboratorMap,
        });

        expect(result.tokens).toHaveLength(3); // Alice, Bob, charlie
        expect(result.dispatchedNotifications).toHaveLength(2); // Alice & Bob (Charlie suppressed)

        const aliceNotif = await repo.findByUser('user-alice-id');
        expect(aliceNotif).toHaveLength(1);
        expect(aliceNotif[0].type).toBe('mention');
        expect(aliceNotif[0].messageOpts.actorName).toBe('Charlie');

        const bobNotif = await repo.findByUser('user-bob-id');
        expect(bobNotif).toHaveLength(1);

        const charlieNotif = await repo.findByUser('user-charlie-id');
        expect(charlieNotif).toHaveLength(0);
      });

      it('should ignore mentions of users not in collaboratorMap', async () => {
        const result = await parseAndNotifyUseCase.execute({
          text: 'Hello @random_person!',
          actorId: 'user-1',
          projectId: 'proj-1',
          collaboratorMap: {},
        });

        expect(result.tokens).toHaveLength(1);
        expect(result.dispatchedNotifications).toHaveLength(0);
      });
    });
  });

  // =========================================================================
  // 4. SERVICE FACADE & REST CONTROLLERS
  // =========================================================================
  describe('Service Facade & Controllers', () => {
    let repo: InMemoryNotificationAdapter;
    let notifier: EventRealtimeNotifierAdapter;
    let parser: RegexMentionParserAdapter;
    let service: NotificationsService;
    let controller: NotificationsController;
    let overleafCompatController: OverleafNotificationsParityController;

    beforeEach(() => {
      repo = new InMemoryNotificationAdapter();
      notifier = new EventRealtimeNotifierAdapter();
      parser = new RegexMentionParserAdapter();

      const createUseCase = new CreateNotificationUseCase(repo, notifier);
      const getUserNotifsUseCase = new GetUserNotificationsUseCase(repo);
      const getUnreadCountUseCase = new GetUnreadCountUseCase(repo);
      const markReadUseCase = new MarkNotificationReadUseCase(repo, notifier);
      const markAllReadUseCase = new MarkAllReadUseCase(repo, notifier);
      const deleteUseCase = new DeleteNotificationUseCase(repo, notifier);
      const parseAndNotifyUseCase = new ParseAndNotifyMentionsUseCase(parser, createUseCase);

      service = new NotificationsService(
        createUseCase,
        getUserNotifsUseCase,
        getUnreadCountUseCase,
        markReadUseCase,
        markAllReadUseCase,
        deleteUseCase,
        parseAndNotifyUseCase,
        parser
      );

      controller = new NotificationsController(service);
      overleafCompatController = new OverleafNotificationsParityController(service);
    });

    describe('NotificationsController', () => {
      const mockReq = (userId: string = 'user-123') => ({
        user: { id: userId },
      });

      it('should handle full notification lifecycle via controller', async () => {
        // 1. Create notification
        const created = await controller.createNotification(
          {
            userId: 'user-123',
            templateKey: 'notification_comment_mention',
            messageOpts: { text: 'Hello' },
          },
          mockReq()
        );
        expect(created.id).toBeDefined();

        // 2. Unread count should be 1
        const unreadCount = await controller.getUnreadCount(mockReq());
        expect(unreadCount.count).toBe(1);

        // 3. List notifications
        const list = await controller.getNotifications(mockReq(), {});
        expect(list).toHaveLength(1);

        // 4. Mark read
        const markRes = await controller.markAsRead(created.id, mockReq());
        expect(markRes.success).toBe(true);

        const unreadAfter = await controller.getUnreadCount(mockReq());
        expect(unreadAfter.count).toBe(0);

        // 5. Delete notification
        const delRes = await controller.deleteNotification(created.id, mockReq());
        expect(delRes.success).toBe(true);
      });

      it('should handle parse-mentions endpoint', async () => {
        const res = await controller.parseMentions({
          text: 'Review by @reviewer_one please',
          actorId: 'author-1',
          projectId: 'p1',
          collaboratorMap: { reviewer_one: 'user-rev' },
        });

        expect(res.tokens).toHaveLength(1);
        expect(res.dispatchedNotifications).toHaveLength(1);
      });

      it('should mark all read and delete by key', async () => {
        await service.createNotification({ userId: 'u-test', key: 'batch-k', templateKey: 't1' });
        await service.createNotification({ userId: 'u-test', key: 'batch-k', templateKey: 't2', forceCreate: true });

        const req = mockReq('u-test');
        const markAllRes = await controller.markAllAsRead(req);
        expect(markAllRes.count).toBe(2);

        const delKeyRes = await controller.deleteByKey('batch-k', req);
        expect(delKeyRes.count).toBe(2);
      });
    });

    describe('OverleafNotificationsParityController (1:1 Legacy Overleaf API)', () => {
      it('should support Overleaf service routes: addNotification, getUserNotifications, and removeNotification', async () => {
        // 1. POST /user/:user_id (Overleaf addNotification)
        const addRes = await overleafCompatController.addNotification('overleaf-user-1', {
          key: 'overleaf-key-1',
          templateKey: 'notification_project_invite',
          messageOpts: { projectName: 'Overleaf Doc' },
        });
        expect(addRes.status).toBe('ok');

        // 2. GET /user/:user_id (Overleaf getUserNotifications)
        const notifs = await overleafCompatController.getUserNotifications('overleaf-user-1');
        expect(notifs).toHaveLength(1);
        expect(notifs[0].key).toBe('overleaf-key-1');

        // 3. DELETE /user/:user_id/notification/:notification_id (Overleaf removeNotificationId)
        const delIdRes = await overleafCompatController.removeNotificationId(
          'overleaf-user-1',
          notifs[0].id
        );
        expect(delIdRes.status).toBe('ok');

        const remaining = await overleafCompatController.getUserNotifications('overleaf-user-1');
        expect(remaining).toHaveLength(0);
      });

      it('should support Overleaf removeNotificationKey and removeNotificationByKeyOnly', async () => {
        await overleafCompatController.addNotification('overleaf-user-2', {
          key: 'target-key',
          templateKey: 'tpl',
        });

        const delKeyRes = await overleafCompatController.removeNotificationKey('overleaf-user-2', 'target-key');
        expect(delKeyRes.status).toBe('ok');

        await overleafCompatController.addNotification('overleaf-user-3', {
          key: 'global-key',
          templateKey: 'tpl',
        });
        const delGlobalRes = await overleafCompatController.removeNotificationByKeyOnly('global-key');
        expect(delGlobalRes.status).toBe('ok');
      });
    });
  });

  // =========================================================================
  // 5. DOMAIN SUBMODULES: MANUSCRIPTS & PROJECTS SPECIALIZED SERVICES
  // =========================================================================
  describe('Domain Submodules: Manuscripts & Projects Services', () => {
    let repo: InMemoryNotificationAdapter;
    let notifier: EventRealtimeNotifierAdapter;
    let parser: RegexMentionParserAdapter;
    let service: NotificationsService;

    beforeEach(() => {
      repo = new InMemoryNotificationAdapter();
      notifier = new EventRealtimeNotifierAdapter();
      parser = new RegexMentionParserAdapter();

      const createUseCase = new CreateNotificationUseCase(repo, notifier);
      const getUserNotifsUseCase = new GetUserNotificationsUseCase(repo);
      const getUnreadCountUseCase = new GetUnreadCountUseCase(repo);
      const markReadUseCase = new MarkNotificationReadUseCase(repo, notifier);
      const markAllReadUseCase = new MarkAllReadUseCase(repo, notifier);
      const deleteUseCase = new DeleteNotificationUseCase(repo, notifier);
      const parseAndNotifyUseCase = new ParseAndNotifyMentionsUseCase(parser, createUseCase);

      service = new NotificationsService(
        createUseCase,
        getUserNotifsUseCase,
        getUnreadCountUseCase,
        markReadUseCase,
        markAllReadUseCase,
        deleteUseCase,
        parseAndNotifyUseCase,
        parser
      );
    });

    describe('ManuscriptsNotificationsService', () => {
      it('should dispatch comment mention via specialized submodule service', async () => {
        const notif = await service.manuscripts.notifyCommentMention({
          recipientUserId: 'target-author',
          actorId: 'commenter-1',
          actorName: 'Bob',
          projectId: 'p-1',
          projectName: 'Quantum Paper',
          docId: 'doc-main',
          threadId: 'th-1',
          commentId: 'c-1',
          snippet: 'Please verify lemma 1',
        });

        expect(notif.userId).toBe('target-author');
        expect(notif.type).toBe('mention');
        expect(notif.messageOpts.snippet).toBe('Please verify lemma 1');
        expect(notif.key).toBe('comment-mention-c-1-target-author');
      });

      it('should dispatch comment reply via specialized submodule service', async () => {
        const notif = await service.manuscripts.notifyCommentReply({
          recipientUserId: 'thread-starter',
          actorId: 'replier-1',
          actorName: 'Alice',
          projectId: 'p-1',
          docId: 'doc-main',
          threadId: 'th-1',
          replyId: 'rep-9',
          snippet: 'I have updated the proof',
        });

        expect(notif.userId).toBe('thread-starter');
        expect(notif.type).toBe('comment_reply');
        expect(notif.key).toBe('comment-reply-rep-9-thread-starter');
      });

      it('should dispatch thread resolved and dismiss notifications', async () => {
        // Create a mention first
        await service.manuscripts.notifyCommentMention({
          recipientUserId: 'target-author',
          actorId: 'commenter-1',
          actorName: 'Bob',
          projectId: 'p-1',
          threadId: 'th-resolve-test',
          snippet: 'test',
        });

        const notif = await service.manuscripts.notifyThreadResolved({
          recipientUserId: 'thread-starter',
          actorId: 'resolver-1',
          actorName: 'Professor',
          projectId: 'p-1',
          docId: 'doc-main',
          threadId: 'th-resolve-test',
          quote: 'Formula 2.1',
        });

        expect(notif.type).toBe('thread_resolved');

        // Dismiss thread mentions
        const dismissedCount = await service.manuscripts.dismissThreadNotifications('th-resolve-test');
        expect(dismissedCount).toBe(1);
      });
    });

    describe('ProjectsNotificationsService', () => {
      it('should dispatch and dismiss project invitations via specialized submodule service', async () => {
        const notif = await service.projects.notifyProjectInvitation({
          recipientUserId: 'invitee-1',
          projectId: 'proj-invite-1',
          projectName: 'Deep Learning',
          inviterId: 'inviter-1',
          inviterName: 'Lead Researcher',
          role: 'collaborator',
          token: 'token-abc',
          expiresAt: new Date(Date.now() + 86400000),
        });

        expect(notif.userId).toBe('invitee-1');
        expect(notif.type).toBe('project_invite');
        expect(notif.key).toBe('project_invite_proj-invite-1_invitee-1');

        // Dismiss invitation
        const dismissed = await service.projects.dismissProjectInvitation('proj-invite-1', 'invitee-1');
        expect(dismissed).toBe(1);
      });
    });
  });
});

