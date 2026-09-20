import { CollaborationService } from '@/modules/document/collaboration/collaboration.service';
import { YjsDocumentManager } from '@/modules/document/collaboration/yjs-document.manager';
import { PageRepository } from '@/modules/document/page/page.repository';
import { COLLABORATION_REDIS_KEYS } from '@/modules/document/page/constants/page-redis-keys.constant';
import * as Y from 'yjs';

describe('Realtime Collaboration Redis Tier (Overleaf Distributed State)', () => {
  const mockPageId = '44444444-4444-4444-4444-444444444444';
  const mockUserId1 = 'user-1';
  const mockUserId2 = 'user-2';

  describe('CollaborationService (Distributed Presence via Redis Hashes)', () => {
    let service: CollaborationService;
    let mockRedisClient: any;
    let mockRedisCache: any;
    let mockEventEmitter: any;

    beforeEach(() => {
      mockRedisClient = {
        hset: jest.fn().mockResolvedValue(1),
        hdel: jest.fn().mockResolvedValue(1),
        hgetall: jest.fn().mockResolvedValue({}),
        expire: jest.fn().mockResolvedValue(1),
      };

      mockRedisCache = {
        getClient: jest.fn().mockReturnValue(mockRedisClient),
        isReady: jest.fn().mockReturnValue(true),
      };

      mockEventEmitter = {
        emit: jest.fn(),
      };

      service = new CollaborationService(mockEventEmitter, mockRedisCache);
    });

    it('should save user presence to Redis Hash with 60s sliding TTL', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        [mockUserId1]: JSON.stringify({
          id: mockUserId1,
          name: 'Alice',
          role: 'CONTRIBUTOR',
          color: '#3B82F6',
          lastHeartbeat: Date.now(),
        }),
      });

      const users = await service.updatePresence(mockPageId, {
        id: mockUserId1,
        name: 'Alice',
        role: 'CONTRIBUTOR',
      });

      expect(mockRedisClient.hset).toHaveBeenCalledWith(
        COLLABORATION_REDIS_KEYS.presence(mockPageId),
        mockUserId1,
        expect.any(String),
      );
      expect(mockRedisClient.expire).toHaveBeenCalledWith(
        COLLABORATION_REDIS_KEYS.presence(mockPageId),
        60,
      );
      expect(users.length).toBe(1);
      expect(users[0].name).toBe('Alice');
    });

    it('should remove user from Redis Hash on leaveRoom', async () => {
      await service.leaveRoom(mockPageId, mockUserId1);

      expect(mockRedisClient.hdel).toHaveBeenCalledWith(
        COLLABORATION_REDIS_KEYS.presence(mockPageId),
        mockUserId1,
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'document.collaboration.event',
        expect.objectContaining({
          pageId: mockPageId,
          type: 'user-left',
          userId: mockUserId1,
        }),
      );
    });

    it('should prune stale presence users (> 35s) when querying getActiveUsers', async () => {
      const now = Date.now();
      mockRedisClient.hgetall.mockResolvedValue({
        [mockUserId1]: JSON.stringify({
          id: mockUserId1,
          name: 'Active User',
          role: 'CONTRIBUTOR',
          color: '#3B82F6',
          lastHeartbeat: now, // active
        }),
        [mockUserId2]: JSON.stringify({
          id: mockUserId2,
          name: 'Stale User',
          role: 'REVIEWER',
          color: '#EF4444',
          lastHeartbeat: now - 50_000, // 50s ago (stale!)
        }),
      });

      const active = await service.getActiveUsers(mockPageId);

      expect(active.length).toBe(1);
      expect(active[0].id).toBe(mockUserId1);
      expect(mockRedisClient.hdel).toHaveBeenCalledWith(
        COLLABORATION_REDIS_KEYS.presence(mockPageId),
        mockUserId2,
      );
    });

    it('should gracefully fallback to in-memory presence when Redis is offline', async () => {
      mockRedisCache.isReady.mockReturnValue(false);

      const users = await service.updatePresence(mockPageId, {
        id: mockUserId1,
        name: 'Offline Alice',
        role: 'OWNER',
      });

      expect(mockRedisClient.hset).not.toHaveBeenCalled();
      expect(users.length).toBe(1);
      expect(users[0].name).toBe('Offline Alice');
    });
  });

  describe('YjsDocumentManager (L2 Redis Snapshot & Zero-Data-Loss)', () => {
    let manager: YjsDocumentManager;
    let mockPageRepo: jest.Mocked<Partial<PageRepository>>;
    let mockRedisCache: any;

    beforeEach(() => {
      mockPageRepo = {
        findPageById: jest.fn().mockResolvedValue({
          id: mockPageId,
          content: 'PostgreSQL Content',
        } as any),
        updatePage: jest.fn().mockResolvedValue({} as any),
      };

      mockRedisCache = {
        isReady: jest.fn().mockReturnValue(true),
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      };

      manager = new YjsDocumentManager(
        mockPageRepo as PageRepository,
        undefined,
        mockRedisCache,
      );
    });

    afterEach(async () => {
      await manager.onModuleDestroy();
    });

    it('should restore Y.Doc from Redis L2 Binary Snapshot when present (skipping Postgres)', async () => {
      // Create a sample doc and generate binary update
      const sourceDoc = new Y.Doc();
      const text = sourceDoc.getText('monaco');
      text.insert(0, 'Redis Snapshot Content (Recovered)');
      const binarySnapshot = Y.encodeStateAsUpdate(sourceDoc);
      const base64Snapshot = Buffer.from(binarySnapshot).toString('base64');
      sourceDoc.destroy();

      // Return snapshot from Redis
      mockRedisCache.get.mockResolvedValue(base64Snapshot);

      const session = await manager.getOrCreateDoc(mockPageId);

      expect(mockRedisCache.get).toHaveBeenCalledWith(
        COLLABORATION_REDIS_KEYS.snapshot(mockPageId),
      );
      expect(manager.getText(mockPageId)).toBe(
        'Redis Snapshot Content (Recovered)',
      );
      // Postgres should NOT have been called because Redis was hit
      expect(mockPageRepo.findPageById).not.toHaveBeenCalled();
    });

    it('should fallback to Postgres when Redis snapshot is missing and seed Redis', async () => {
      mockRedisCache.get.mockResolvedValue(null);

      const session = await manager.getOrCreateDoc(mockPageId);

      expect(mockPageRepo.findPageById).toHaveBeenCalledWith(mockPageId);
      expect(manager.getText(mockPageId)).toBe('PostgreSQL Content');
      // Should write initial snapshot to Redis with 7-day TTL
      expect(mockRedisCache.set).toHaveBeenCalledWith(
        COLLABORATION_REDIS_KEYS.snapshot(mockPageId),
        expect.any(String),
        7 * 24 * 3600,
      );
    });

    it('should persist L2 binary snapshot to Redis during flushToDatabase', async () => {
      await manager.getOrCreateDoc(mockPageId);

      // Mutate document
      const clientDoc = new Y.Doc();
      const clientText = clientDoc.getText('monaco');
      clientText.insert(0, 'Newly Typed Edits\n');
      const update = Y.encodeStateAsUpdate(clientDoc);
      manager.applyUpdate(mockPageId, update);
      clientDoc.destroy();

      await manager.flushToDatabase(mockPageId);

      // Verify PostgreSQL update
      expect(mockPageRepo.updatePage).toHaveBeenCalled();
      // Verify Redis snapshot update
      expect(mockRedisCache.set).toHaveBeenCalledWith(
        COLLABORATION_REDIS_KEYS.snapshot(mockPageId),
        expect.any(String),
        7 * 24 * 3600,
      );
    });
  });
});
