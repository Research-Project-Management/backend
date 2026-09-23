import { ItemsService } from '../../src/modules/library/bibliography/application/services/items.service';
import { AttachmentsService } from '../../src/modules/library/reader/application/services/attachments.service';
import { IdempotencyMiddleware } from '../../src/modules/library/shared-kernel/core/middlewares/idempotency.middleware';
import { NotFoundException } from '@nestjs/common';
import { RedisCacheService } from '../../src/core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '../../src/modules/library/shared-kernel/core/constants/redis-keys.constant';

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

  describe('2. Security: Project Membership Check in AttachmentsService.addRevision', () => {
    let service: AttachmentsService;
    let mockRepo: any;
    let mockTx: any;

    const creatorId = '00000000-0000-0000-0000-000000000001';
    const memberId = '00000000-0000-0000-0000-000000000002';
    const nonMemberAttackerId = '00000000-0000-0000-0000-000000000003';
    const projectId = '99999999-9999-9999-9999-999999999999';
    const attachmentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    beforeEach(() => {
      mockRepo = {
        findUnique: jest.fn(),
        checkProjectMember: jest.fn(),
        updateLinkedFile: jest.fn(),
      };
      mockTx = {
        executeInTransaction: jest.fn((cb) =>
          cb(
            {
              attachment: { update: jest.fn().mockResolvedValue({}) },
              attachmentRevision: { create: jest.fn().mockResolvedValue({}) },
            },
            {
              emitOutbox: jest.fn(),
              appendChange: jest.fn().mockResolvedValue(undefined),
            },
          ),
        ),
      };

      service = new AttachmentsService(mockRepo, mockTx);
    });

    it('should REJECT revision upload if caller is NOT a member of the project', async () => {
      mockRepo.findUnique.mockResolvedValueOnce({
        id: attachmentId,
        itemId: 'item-1',
        filename: 'paper.pdf',
        size: 100n,
        revisions: [{ revisionNumber: 1 }],
        item: {
          id: 'item-1',
          userId: creatorId,
          projectId: projectId, // Project item
        },
      });

      // Attacker is NOT a member of this project
      mockRepo.checkProjectMember.mockResolvedValueOnce(null);

      await expect(
        service.addRevision(
          nonMemberAttackerId,
          attachmentId,
          { filename: 'malicious.pdf', url: 'https://evil.com/malicious.pdf' },
          projectId,
        ),
      ).rejects.toThrow(NotFoundException);

      expect(mockRepo.checkProjectMember).toHaveBeenCalledWith(
        projectId,
        nonMemberAttackerId,
      );
      expect(mockTx.executeInTransaction).not.toHaveBeenCalled();
    });

    it('should ALLOW revision upload if caller IS a verified member of the project', async () => {
      mockRepo.findUnique.mockResolvedValueOnce({
        id: attachmentId,
        itemId: 'item-1',
        filename: 'paper.pdf',
        size: 100n,
        fileHash: 'sha-old',
        revisions: [{ revisionNumber: 1 }],
        item: {
          id: 'item-1',
          userId: creatorId,
          projectId: projectId,
        },
      });

      // Member check succeeds
      mockRepo.checkProjectMember.mockResolvedValueOnce({ role: 'contributor' });

      await service.addRevision(
        memberId,
        attachmentId,
        {
          filename: 'updated.pdf',
          url: 'https://storage.flux.ai/files/updated.pdf',
          fileHash: 'sha-new',
        },
        projectId,
      );

      expect(mockRepo.checkProjectMember).toHaveBeenCalledWith(
        projectId,
        memberId,
      );
      expect(mockTx.executeInTransaction).toHaveBeenCalled();
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
