import { ItemsService } from '@/modules/library/catalog/core/services/items.service';
import { AttachmentsService } from '@/modules/library/extraction/core/services/attachments.service';
import { IdempotencyMiddleware } from '../../src/modules/library/shared-kernel/core/middlewares/idempotency.middleware';
import { NotFoundException } from '@nestjs/common';
import { RedisCacheService } from '../../src/core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../../src/modules/library/shared-kernel/core/constants/redis-keys.constants';

describe('Library Security Hardening & Performance Optimization', () => {
  describe('1. Security: Multi-Tenant Cache Isolation in ItemsService.getFulltext', () => {
    let service: ItemsService;
    let mockQueryRepo: any;
    let mockCommandRepo: any;
    let mockTxService: any;
    let mockCache: Partial<RedisCacheService>;

    const victimUserId = '00000000-0000-0000-0000-000000000001';
    const attackerUserId = '00000000-0000-0000-0000-000000000002';
    const sampleItemId = '11111111-1111-1111-1111-111111111111';

    beforeEach(() => {
      mockQueryRepo = {
        findById: jest.fn(),
        findMetadataSourceRecord: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      };
      mockCommandRepo = {};
      mockTxService = {};
      mockCache = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        delPattern: jest.fn(),
      };

      service = new ItemsService(
        mockQueryRepo,
        mockCommandRepo,
        mockTxService,
        {} as any,
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        mockCache as RedisCacheService,
      );
    });

    it('should save ownership metadata (userId, projectId) alongside fulltext in cache on cache miss', async () => {
      (mockCache.get as jest.Mock).mockResolvedValueOnce(null);
      mockQueryRepo.findById.mockResolvedValueOnce({
        id: sampleItemId,
        userId: victimUserId,
        projectId: null,
        title: 'Confidential Research Findings',
        abstract: 'Secret data',
      });
      mockQueryRepo.findMetadataSourceRecord.mockResolvedValueOnce({
        rawPayload: {
          title: 'Confidential Research Findings',
          sections: [{ title: 'Section 1', text: 'Top secret findings' }],
        },
      });

      const res = await service.getFulltext(victimUserId, sampleItemId);

      expect(res.title).toBe('Confidential Research Findings');
      expect(mockCache.set).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.itemFulltext(sampleItemId),
        expect.objectContaining({
          userId: victimUserId,
          projectId: null,
          title: 'Confidential Research Findings',
          sections: expect.any(Array),
        }),
        600,
      );
    });

    it('should allow legitimate owner to retrieve fulltext from cache without DB query (Cache Hit)', async () => {
      const cachedData = {
        userId: victimUserId,
        projectId: null,
        title: 'Confidential Research Findings',
        sections: [{ title: 'Section 1', text: 'Top secret findings' }],
      };
      (mockCache.get as jest.Mock).mockResolvedValueOnce(cachedData);

      const res = await service.getFulltext(victimUserId, sampleItemId);

      expect(res.title).toBe('Confidential Research Findings');
      expect(mockQueryRepo.findById).not.toHaveBeenCalled();
      expect(mockQueryRepo.findMetadataSourceRecord).not.toHaveBeenCalled();
    });

    it('should REJECT cache retrieval when attacker attempts to read victim cached item (IDOR Prevention)', async () => {
      // Item is cached under victim's ownership
      const cachedData = {
        userId: victimUserId,
        projectId: null,
        title: 'Confidential Research Findings',
        sections: [{ title: 'Section 1', text: 'Top secret findings' }],
      };
      (mockCache.get as jest.Mock).mockResolvedValueOnce(cachedData);

      // Attacker has NO access in DB
      mockQueryRepo.findById.mockResolvedValueOnce(null);

      // Attacker calls getFulltext
      await expect(
        service.getFulltext(attackerUserId, sampleItemId),
      ).rejects.toThrow(NotFoundException);

      // Verified: Cache was rejected because cached.userId !== attackerUserId,
      // and DB authorization check failed.
      expect(mockQueryRepo.findById).toHaveBeenCalledWith(
        attackerUserId,
        sampleItemId,
        undefined,
      );
    });
  });

  describe('3. Security: Tenant-Isolated IdempotencyMiddleware', () => {
    let middleware: IdempotencyMiddleware;

    beforeEach(() => {
      middleware = new IdempotencyMiddleware();
    });

    it('should isolate idempotency keys between different users so they do not collide or leak responses', () => {
      const userAReq = {
        method: 'POST',
        path: '/api/v1/library/items',
        headers: { 'x-idempotency-key': 'same-key-123', 'x-user-id': 'user-a' },
      };
      const userARes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      };
      const nextA = jest.fn();

      middleware.use(userAReq, userARes, nextA);
      expect(nextA).toHaveBeenCalled();

      // Complete User A's response
      userARes.json({ itemId: 'item-user-a', secret: 'secret-a' });

      // Now User B sends a request with the SAME idempotency key
      const userBReq = {
        method: 'POST',
        path: '/api/v1/library/items',
        headers: { 'x-idempotency-key': 'same-key-123', 'x-user-id': 'user-b' },
      };
      const userBJsonSpy = jest.fn();
      const userBRes = {
        json: userBJsonSpy,
        status: jest.fn().mockReturnThis(),
      };
      const nextB = jest.fn();

      middleware.use(userBReq, userBRes, nextB);

      // User B must NOT receive User A's response — it proceeds to handler!
      expect(nextB).toHaveBeenCalled();
      expect(userBJsonSpy).not.toHaveBeenCalled();
    });
  });

  describe('4. Performance: Cursor Pagination COUNT(*) Optimization in ItemsService.listItems', () => {
    let service: ItemsService;
    let mockQueryRepo: any;

    const userId = '00000000-0000-0000-0000-000000000001';

    beforeEach(() => {
      mockQueryRepo = {
        count: jest.fn().mockResolvedValue(100),
        findMany: jest.fn().mockResolvedValue([
          { id: 'item-1', title: 'Paper 1', metadata: {} },
          { id: 'item-2', title: 'Paper 2', metadata: {} },
        ]),
      };

      service = new ItemsService(
        mockQueryRepo,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    });

    it('should execute COUNT(*) query on initial page (when cursor is undefined)', async () => {
      const result = await service.listItems(userId, { limit: 10 });

      expect(mockQueryRepo.count).toHaveBeenCalledTimes(1);
      expect(result.meta.totalCount).toBe(100);
      expect(result.items).toHaveLength(2);
    });

    it('should SKIP COUNT(*) query on subsequent pages (when cursor is present) to save DB cycles', async () => {
      const result = await service.listItems(userId, {
        limit: 10,
        cursor: 'item-cursor-1',
      });

      expect(mockQueryRepo.count).not.toHaveBeenCalled();
      expect(result.meta.totalCount).toBeUndefined();
      expect(result.items).toHaveLength(2);
    });
  });
});
