import {
  SyncController,
  SyncQueryDto,
} from '@/modules/library/sync/controllers/sync.controller';
import { TransactionService } from '@/modules/library/sync/services/transaction.service';
import { ChangeLogRepository } from '@/modules/library/sync/repositories/changelog.repository';
import { IdempotentConsumerService } from '@/modules/library/sync/services/idempotent-consumer.service';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core';

describe('Library Sync — SyncController, TransactionService, ChangeLog Purging & IdempotentConsumer', () => {
  describe('SyncController', () => {
    let controller: SyncController;
    let txMock: {
      getLatestSequence: jest.Mock;
      getChangesSince: jest.Mock;
      getTombstonesSince: jest.Mock;
      getMinRetainedSequence?: jest.Mock;
    };

    beforeEach(() => {
      txMock = {
        getLatestSequence: jest.fn(),
        getChangesSince: jest.fn(),
        getTombstonesSince: jest.fn(),
      };
      controller = new SyncController(txMock as unknown as TransactionService);
    });

    it('returns user/project sync version, serializes BigInt seqs, compacts create+delete to terminal delete, paginates tombstones, and returns HTTP 410 on expired cursor', async () => {
      txMock.getLatestSequence.mockResolvedValueOnce(42n);
      expect(await controller.getSyncVersion('user-123')).toEqual({
        version: '42',
        scope: 'user',
        spaceId: 'user-123',
      });

      txMock.getLatestSequence.mockResolvedValueOnce(105n);
      expect(
        await controller.getSyncVersion('user-123', 'proj-456', undefined),
      ).toEqual({
        version: '105',
        scope: 'project',
        spaceId: 'proj-456',
      });

      txMock.getChangesSince.mockResolvedValueOnce([
        {
          id: 'c-create',
          seq: 10n,
          userId: 'user-123',
          projectId: null,
          entityType: 'item',
          entityId: 'item-ephemeral',
          action: 'create',
          version: 1,
          data: { title: 'Restored then Deleted' },
          createdAt: new Date('2026-09-22T10:00:00Z'),
        },
        {
          id: 'c-delete',
          seq: 11n,
          userId: 'user-123',
          projectId: null,
          entityType: 'item',
          entityId: 'item-ephemeral',
          action: 'delete',
          version: 2,
          data: null,
          createdAt: new Date('2026-09-22T10:01:00Z'),
        },
      ]);

      const query: SyncQueryDto = { since: '9', limit: 50 };
      const compacted = await controller.getChanges('user-123', query);
      expect(compacted.count).toBe(1);
      expect(compacted.changes[0]).toMatchObject({
        entityId: 'item-ephemeral',
        action: 'delete',
        seq: '11',
      });

      txMock.getTombstonesSince.mockResolvedValueOnce(
        Array.from({ length: 3 }, (_, i) => ({
          id: `tomb-${i}`,
          seq: BigInt(i + 1),
          userId: 'user-123',
          projectId: null,
          entityType: 'item',
          entityId: `del-${i}`,
          deletedById: 'user-123',
          deletedAt: new Date(),
        })),
      );
      const tombs = await controller.getTombstones('user-123', { limit: 2 });
      expect(tombs.count).toBe(2);
      expect(tombs.hasMore).toBe(true);
      expect(tombs.tombstones[0].seq).toBe('1');

      txMock.getMinRetainedSequence = jest.fn().mockResolvedValue(100n);
      await expect(
        controller.getChanges('user-123', { since: '50' }),
      ).rejects.toMatchObject({
        status: 410,
        response: expect.objectContaining({
          code: 'SYNC_RESET_REQUIRED',
          minRetainedSequence: '100',
        }),
      });
    });
  });

  describe('TransactionService & ChangeLogRepository', () => {
    it('coalesces cold getLatestSequence polls, serves warm Redis cache, invalidates post-commit, and purges expired rows', async () => {
      const redisStore = new Map<string, string>();
      const mockCache = {
        get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
        set: jest.fn(async (k: string, v: string) => {
          redisStore.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          redisStore.delete(k);
        }),
      };
      const mockChangeLogRepo = {
        getLatestSequence: jest.fn(
          () =>
            new Promise<bigint>((resolve) => setTimeout(() => resolve(88n), 1)),
        ),
        getMinRetainedSequence: jest.fn(async () => 12n),
        appendChange: jest.fn(async () => ({ id: 'c1', seq: 89n })),
      };
      const txService = new TransactionService(
        {
          $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({}),
          ),
        } as never,
        mockChangeLogRepo as never,
        undefined,
        undefined,
        undefined,
        mockCache as never,
      );

      const projectScope = {
        projectId: '11111111-1111-4111-8111-111111111111',
      };
      const cold = await Promise.all(
        Array.from({ length: 50 }, () =>
          txService.getLatestSequence(projectScope),
        ),
      );
      expect(cold.every((s) => s === 88n)).toBe(true);
      expect(mockChangeLogRepo.getLatestSequence).toHaveBeenCalledTimes(1);

      await Promise.all(
        Array.from({ length: 20 }, () =>
          txService.getLatestSequence(projectScope),
        ),
      );
      expect(mockChangeLogRepo.getLatestSequence).toHaveBeenCalledTimes(1);

      mockChangeLogRepo.getLatestSequence.mockImplementationOnce(
        async () => 89n,
      );
      await txService.executeInTransaction(async (_tx, helpers) => {
        await helpers.appendChange(projectScope, {
          entityType: 'Item',
          entityId: 'item-1',
          action: 'update',
          version: 2,
          data: { id: 'item-1' },
        });
      });
      expect(mockCache.del).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.syncSequence(`proj:${projectScope.projectId}`),
      );
      expect(await txService.getLatestSequence(projectScope)).toBe(89n);

      const changeLogPrisma = {
        libraryChange: {
          findMany: jest.fn(async () => [{ id: 'lc-1' }, { id: 'lc-2' }]),
          deleteMany: jest.fn(async () => ({ count: 2 })),
        },
        tombstone: {
          findMany: jest.fn(async () => [{ id: 'tb-1' }]),
          deleteMany: jest.fn(async () => ({ count: 1 })),
        },
      };
      const changeLogRepo = new ChangeLogRepository(changeLogPrisma as never);
      expect(await changeLogRepo.compactAndPurgeChangeLog(30, 500)).toEqual({
        purgedChanges: 2,
        purgedTombstones: 1,
      });
    });
  });

  describe('IdempotentConsumerService (In-Memory & Distributed Redis)', () => {
    it('deduplicates completed and in-flight events and releases lease on exception across memory and Redis modes', async () => {
      const memService = new IdempotentConsumerService();
      memService.clearMemoryStore();

      let resolveSlow!: (v: string) => void;
      const slowPromise = new Promise<string>((r) => {
        resolveSlow = r;
      });
      const firstRun = memService.executeIdempotent({
        consumer: 'c1',
        eventId: 'evt-1',
        handler: async () => slowPromise,
      });
      const concurrentDup = await memService.executeIdempotent({
        consumer: 'c1',
        eventId: 'evt-1',
        handler: async () => 'dup',
      });
      expect(concurrentDup).toMatchObject({ skipped: true, reason: 'IN_FLIGHT' });
      resolveSlow('ok');
      expect((await firstRun).result).toBe('ok');

      const completedDup = await memService.executeIdempotent({
        consumer: 'c1',
        eventId: 'evt-1',
        handler: async () => 'dup',
      });
      expect(completedDup).toMatchObject({
        skipped: true,
        reason: 'ALREADY_COMPLETED',
      });

      await memService.reset('c1', 'evt-1');
      expect(await memService.isProcessed('c1', 'evt-1')).toBe(false);

      const redisStore = new Map<string, string>();
      const mockClient = {
        set: jest.fn(async (key: string, val: string, ...args: unknown[]) => {
          if (args.includes('NX') && redisStore.has(key)) return null;
          redisStore.set(key, val);
          return 'OK';
        }),
        get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
        del: jest.fn(async (key: string) => {
          redisStore.delete(key);
          return 1;
        }),
      };
      const redisConsumer = new IdempotentConsumerService({
        isReady: () => true,
        getClient: () => mockClient,
      } as never);

      await expect(
        redisConsumer.executeIdempotent({
          consumer: 'worker',
          eventId: 'evt-redis',
          handler: async () => {
            throw new Error('Transient failure');
          },
        }),
      ).rejects.toThrow('Transient failure');
      expect(mockClient.del).toHaveBeenCalledWith(
        'library:inbox:worker:evt-redis',
      );

      const retryOk = await redisConsumer.executeIdempotent({
        consumer: 'worker',
        eventId: 'evt-redis',
        leaseTtlSeconds: 120,
        retentionTtlSeconds: 3600,
        handler: async () => 'recovered',
      });
      expect(retryOk).toMatchObject({ executed: true, result: 'recovered' });

      const afterRetryDup = await redisConsumer.executeIdempotent({
        consumer: 'worker',
        eventId: 'evt-redis',
        handler: async () => 'dup',
      });
      expect(afterRetryDup).toMatchObject({
        skipped: true,
        reason: 'ALREADY_COMPLETED',
      });
    });
  });
});
