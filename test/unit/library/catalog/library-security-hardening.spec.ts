import { ItemFulltextService } from '@/modules/library/catalog/services/item-fulltext.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { NotFoundException } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/constants/redis-keys.constants';

describe('Library Security Hardening & Performance Optimization', () => {
  describe('1. Security: Multi-Tenant Cache Isolation in ItemFulltextService.getFulltext', () => {
    let fulltextService: ItemFulltextService;
    let mockQueryRepo: any;
    let mockCache: Partial<RedisCacheService>;

    const victimUserId = '00000000-0000-0000-0000-000000000001';
    const attackerUserId = '00000000-0000-0000-0000-000000000002';
    const sampleItemId = '11111111-1111-1111-1111-111111111111';

    beforeEach(() => {
      mockQueryRepo = {
        findById: jest.fn(),
        findItemMetadata: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      };
      mockCache = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        delPattern: jest.fn(),
      };

      fulltextService = new ItemFulltextService(
        mockQueryRepo,
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
      mockQueryRepo.findItemMetadata.mockResolvedValueOnce({
        rawPayload: {
          title: 'Confidential Research Findings',
          sections: [{ title: 'Section 1', text: 'Top secret findings' }],
        },
      });

      const res = await fulltextService.getFulltext(victimUserId, sampleItemId);

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

      const res = await fulltextService.getFulltext(victimUserId, sampleItemId);

      expect(res.title).toBe('Confidential Research Findings');
      expect(mockQueryRepo.findById).not.toHaveBeenCalled();
      expect(mockQueryRepo.findItemMetadata).not.toHaveBeenCalled();
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
        fulltextService.getFulltext(attackerUserId, sampleItemId),
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

  describe('4. Performance: Cursor Pagination COUNT(*) Optimization in ItemQueryService.listItems', () => {
    let queryService: ItemQueryService;
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

      queryService = new ItemQueryService(mockQueryRepo, undefined);
    });

    it('should execute COUNT(*) query on initial page (when cursor is undefined)', async () => {
      const result = await queryService.listItems(userId, { limit: 10 });

      expect(mockQueryRepo.count).toHaveBeenCalledTimes(1);
      expect(result.meta.totalCount).toBe(100);
      expect(result.items).toHaveLength(2);
    });

    it('should SKIP COUNT(*) query on subsequent pages (when cursor is present) to save DB cycles', async () => {
      const result = await queryService.listItems(userId, {
        limit: 10,
        cursor: 'item-cursor-1',
      });

      expect(mockQueryRepo.count).not.toHaveBeenCalled();
      expect(result.meta.totalCount).toBeUndefined();
      expect(result.items).toHaveLength(2);
    });
  });
});
