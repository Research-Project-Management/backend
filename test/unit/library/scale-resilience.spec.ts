import { SingleFlightCoalescer } from '@/modules/library/core/resilience/circuit-breaker';
import { TransactionService } from '@/modules/library/sync/services/transaction.service';
import { LibraryBootstrapService } from '@/modules/library/catalog/services/library-bootstrap.service';
import { TypesService } from '@/modules/library/catalog/services/schema-validator.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { TagsService } from '@/modules/library/catalog/services/tags.service';
import { SavedSearchesService } from '@/modules/library/catalog/services/saved-searches.service';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/config/library.config';
import { ChangeLogRepository } from '@/modules/library/sync/repositories/changelog.repository';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { ItemListQueryRepository } from '@/modules/library/catalog/repositories/item-list-query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { executeCopyCollectionSubtree } from '@/modules/library/catalog/repositories/collection-membership.operations';
import { TreeEngine } from '@/modules/library/catalog/domain/state.domain';

describe('Library High-Concurrency & 1k-10k User Scale Resilience', () => {
  describe('SingleFlightCoalescer — In-Process Thundering Herd Prevention', () => {
    it('coalesces 1,000 concurrent requests for the same key into exactly 1 execution', async () => {
      const coalescer = new SingleFlightCoalescer();
      let executionCount = 0;

      const slowDbOperation = () =>
        new Promise<{ seq: string }>((resolve) => {
          executionCount++;
          setTimeout(() => resolve({ seq: '1042' }), 15);
        });

      const callers = Array.from({ length: 1000 }, () =>
        coalescer.execute('proj:shared-1000', slowDbOperation),
      );

      expect(coalescer.inFlightCount).toBe(1);
      const results = await Promise.all(callers);

      expect(executionCount).toBe(1);
      expect(coalescer.inFlightCount).toBe(0);
      expect(results).toHaveLength(1000);
      expect(results.every((r) => r.seq === '1042')).toBe(true);
    });

    it('cleans up in-flight state on rejection so subsequent retries succeed', async () => {
      const coalescer = new SingleFlightCoalescer();
      let attempts = 0;

      const flakyOp = async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Transient DB timeout');
        }
        return 'recovered';
      };

      await expect(
        Promise.all([
          coalescer.execute('key-1', flakyOp),
          coalescer.execute('key-1', flakyOp),
        ]),
      ).rejects.toThrow('Transient DB timeout');

      expect(attempts).toBe(1);
      expect(coalescer.inFlightCount).toBe(0);

      const secondWave = await coalescer.execute('key-1', flakyOp);
      expect(secondWave).toBe('recovered');
      expect(attempts).toBe(2);
    });
  });

  describe('TransactionService — O(1) Redis Sync Sequence & Post-Commit Invalidation', () => {
    it('serves getLatestSequence from Redis and coalesces 500 concurrent project polls onto 1 DB lookup on cache miss', async () => {
      const redisStore = new Map<string, string>();
      const mockCache = {
        get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
        set: jest.fn(async (key: string, val: string) => {
          redisStore.set(key, val);
        }),
        del: jest.fn(async (key: string) => {
          redisStore.delete(key);
        }),
      };

      const mockChangeLogRepo = {
        getLatestSequence: jest.fn(
          () =>
            new Promise<bigint>((resolve) => {
              setTimeout(() => resolve(88n), 10);
            }),
        ),
        getMinRetainedSequence: jest.fn(async () => 12n),
        appendChange: jest.fn(async () => ({ id: 'c1', seq: 89n })),
      };

      const mockPrisma = {
        $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({}),
        ),
      };

      const txService = new TransactionService(
        mockPrisma as never,
        mockChangeLogRepo as never,
        undefined,
        undefined,
        undefined,
        mockCache as never,
      );

      const projectScope = { projectId: '11111111-1111-4111-8111-111111111111' };

      // 1. 500 concurrent collaborators poll /sync/version on cold Redis cache
      const coldPolls = await Promise.all(
        Array.from({ length: 500 }, () =>
          txService.getLatestSequence(projectScope),
        ),
      );
      expect(coldPolls.every((seq) => seq === 88n)).toBe(true);
      expect(mockChangeLogRepo.getLatestSequence).toHaveBeenCalledTimes(1);

      // 2. Subsequent 500 polls hit warm Redis cache -> 0 additional DB queries
      const warmPolls = await Promise.all(
        Array.from({ length: 500 }, () =>
          txService.getLatestSequence(projectScope),
        ),
      );
      expect(warmPolls.every((seq) => seq === 88n)).toBe(true);
      expect(mockChangeLogRepo.getLatestSequence).toHaveBeenCalledTimes(1);

      // 3. A write transaction appends a change -> invalidates sync sequence cache post-commit
      mockChangeLogRepo.getLatestSequence.mockImplementationOnce(async () => 89n);
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
        LIBRARY_REDIS_KEYS.syncSequence(
          `proj:${projectScope.projectId}`,
        ),
      );

      // 4. Next poll observes fresh sequence 89n
      const afterWriteSeq = await txService.getLatestSequence(projectScope);
      expect(afterWriteSeq).toBe(89n);
      expect(mockChangeLogRepo.getLatestSequence).toHaveBeenCalledTimes(2);
    });
  });

  describe('LibraryBootstrapService — Consolidated Workspace Seed & Single-Flight Coalescing', () => {
    it('includes tags in bootstrap payload and coalesces concurrent identical bootstrap calls', async () => {
      const mockQueryRepo = {
        findUserFeedSubscriptions: jest.fn(async () => []),
      };
      const mockItemQuery = {
        getCounts: jest.fn(async () => ({
          total: 2,
          unfiled: 1,
          starred: 0,
          trash: 0,
          itemTypes: { journalArticle: 2 },
          role: 'owner' as const,
          permissions: {
            canRead: true,
            canCreateItem: true,
            canEditItem: true,
            canDeleteItem: true,
            canPurgeItem: true,
            canManageCollections: true,
            canImport: true,
            canExport: true,
            canAnnotate: true,
          },
        })),
        listItems: jest.fn(
          () =>
            new Promise<{
              items: Array<{ id: string }>;
              meta: { hasNextPage: boolean; totalCount: number };
            }>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    items: [{ id: 'it-1' }, { id: 'it-2' }],
                    meta: { hasNextPage: false, totalCount: 2 },
                  }),
                10,
              ),
            ),
        ),
      };
      const mockCollections = {
        getCollections: jest.fn(async () => ({
          collections: [{ id: 'col-1', name: 'ML' }],
          total: 1,
        })),
      };
      const mockSavedSearches = {
        findAll: jest.fn(async () => [{ id: 'ss-1', name: 'Recent AI' }]),
      };
      const mockTags = {
        getTags: jest.fn(async () => [{ id: 'tag-1', name: 'llm', count: 2 }]),
      };
      const mockTx = {
        getLatestSequence: jest.fn(async () => 42n),
      };

      const bootstrapService = new LibraryBootstrapService(
        mockQueryRepo as never,
        mockItemQuery as never,
        mockCollections as never,
        mockSavedSearches as never,
        new TypesService(),
        mockTx as never,
        mockTags as never,
      );

      const userId = '22222222-2222-4222-8222-222222222222';
      const concurrentCalls = await Promise.all(
        Array.from({ length: 50 }, () =>
          bootstrapService.getBootstrap(userId, { view: 'all', limit: 50 }),
        ),
      );

      expect(mockItemQuery.getCounts).toHaveBeenCalledTimes(1);
      expect(mockItemQuery.listItems).toHaveBeenCalledTimes(1);
      expect(mockCollections.getCollections).toHaveBeenCalledTimes(1);
      expect(mockSavedSearches.findAll).toHaveBeenCalledTimes(1);
      expect(mockTags.getTags).toHaveBeenCalledTimes(1);

      const first = concurrentCalls[0];
      expect(first.tags).toEqual([{ id: 'tag-1', name: 'llm', count: 2 }]);
      expect(first.syncVersion.version).toBe('42');
      expect(first.items).toHaveLength(2);
    });
  });

  describe('Catalog Services — Single-Flight Stampede Protection Even Without Redis', () => {
    it('coalesces concurrent getCounts, getCollections, getTags, and findAll SavedSearches calls', async () => {
      const userId = '33333333-3333-4333-8333-333333333333';
      const projectId = '44444444-4444-4444-8444-444444444444';

      // 1. ItemQueryService.getCounts
      const mockQueryRepo = {
        count: jest.fn(
          () => new Promise<number>((r) => setTimeout(() => r(5), 10)),
        ),
        countByItemType: jest.fn(
          () =>
            new Promise<Record<string, number>>((r) =>
              setTimeout(() => r({ journalArticle: 10 }), 10),
            ),
        ),
        getProjectMemberRole: jest.fn(async () => 'owner'),
      };
      const itemQueryService = new ItemQueryService(mockQueryRepo as never);
      await Promise.all(
        Array.from({ length: 100 }, () =>
          itemQueryService.getCounts(userId, projectId),
        ),
      );
      expect(mockQueryRepo.countByItemType).toHaveBeenCalledTimes(1);

      // 2. CollectionsService.getCollections
      const mockCollectionsRepo = {
        findAll: jest.fn(
          () =>
            new Promise<Array<{ id: string; name: string; parentId: null }>>(
              (r) =>
                setTimeout(() => r([{ id: 'c1', name: 'Root', parentId: null }]), 10),
            ),
        ),
      };
      const collectionsService = new CollectionsService(
        mockCollectionsRepo as never,
      );
      await Promise.all(
        Array.from({ length: 100 }, () =>
          collectionsService.getCollections(userId, projectId),
        ),
      );
      expect(mockCollectionsRepo.findAll).toHaveBeenCalledTimes(1);

      // 3. TagsService.getTags
      const mockTagsRepo = {
        findMany: jest.fn(
          () =>
            new Promise<Array<{ id: string; name: string }>>((r) =>
              setTimeout(() => r([{ id: 't1', name: 'tag' }]), 10),
            ),
        ),
      };
      const tagsService = new TagsService(
        mockTagsRepo as never,
        {} as never,
      );
      await Promise.all(
        Array.from({ length: 100 }, () =>
          tagsService.getTags(userId, { projectId }),
        ),
      );
      expect(mockTagsRepo.findMany).toHaveBeenCalledTimes(1);

      // 4. SavedSearchesService.findAll
      const mockSavedSearchesRepo = {
        findAll: jest.fn(
          () =>
            new Promise<Array<{ id: string; cachedCount: number }>>((r) =>
              setTimeout(() => r([{ id: 's1', cachedCount: 3 }]), 10),
            ),
        ),
      };
      const savedSearchesService = new SavedSearchesService(
        mockSavedSearchesRepo as never,
        { extractReferencedCollectionIds: () => [] } as never,
      );
      await Promise.all(
        Array.from({ length: 100 }, () =>
          savedSearchesService.findAll(userId, projectId),
        ),
      );
      expect(mockSavedSearchesRepo.findAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('Database Query & Data Retrieval Optimizations', () => {
    it('eliminates redundant 5th count({ view: "all" }) query in getCounts when countByItemType returns empty {}', async () => {
      const userId = '55555555-5555-4555-8555-555555555555';
      const mockQueryRepo = {
        count: jest.fn(async () => 0),
        countByItemType: jest.fn(async () => ({})),
      };
      const service = new ItemQueryService(mockQueryRepo as never);
      const res = await service.getCounts(userId);

      expect(res.total).toBe(0);
      expect(mockQueryRepo.countByItemType).toHaveBeenCalledTimes(1);
      // Only unfiled, starred, and trash count queries should run — NO 4th count({ view: 'all' })
      expect(mockQueryRepo.count).toHaveBeenCalledTimes(3);
      expect(mockQueryRepo.count).not.toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ view: 'all' }),
      );
    });

    it('uses lean select projections on itemTags, collectionItems, and publications in ItemListQueryRepository.findMany', async () => {
      const userId = '66666666-6666-4666-8666-666666666666';
      const mockFindMany = jest.fn(async () => []);
      const mockPrisma = {
        item: { findMany: mockFindMany },
      };
      const repo = new ItemListQueryRepository(mockPrisma as never);

      await repo.findMany(mockPrisma as never, userId, {
        view: 'all',
        limit: 20,
      });

      expect(mockFindMany).toHaveBeenCalledTimes(1);
      const callArg = mockFindMany.mock.calls[0]?.[0] as {
        include?: Record<string, unknown>;
      };
      expect(callArg.include?.itemTags).toEqual({
        select: {
          tagId: true,
          type: true,
          tag: {
            select: {
              id: true,
              name: true,
              color: true,
              type: true,
              shortcut: true,
            },
          },
        },
      });
      expect(callArg.include?.collectionItems).toEqual({
        select: {
          collectionId: true,
          sortOrder: true,
          collection: {
            select: {
              id: true,
              name: true,
              color: true,
              icon: true,
              parentId: true,
            },
          },
        },
      });
      expect(callArg.include?.publications).toEqual({
        where: { userId },
        select: { itemId: true },
        take: 1,
      });
    });

    it('queries distinct sourceProvider in QueryRepository.findItemMetadataByProviders to avoid loading historical blobs', async () => {
      const itemId = '77777777-7777-4777-8777-777777777777';
      const mockMetadataFindMany = jest.fn(async () => [
        {
          id: 'm1',
          itemId,
          sourceProvider: 'crossref',
          rawPayload: { title: 'Test' },
          createdAt: new Date(),
        },
      ]);
      const mockPrisma = {
        itemMetadata: { findMany: mockMetadataFindMany },
      };
      const repo = new QueryRepository(
        mockPrisma as never,
        {} as never,
        {} as never,
      );

      const res = await repo.findItemMetadataByProviders(itemId, [
        'crossref',
        'openalex',
      ]);

      expect(res?.sourceProvider).toBe('crossref');
      expect(mockMetadataFindMany).toHaveBeenCalledWith({
        where: {
          itemId,
          sourceProvider: { in: ['crossref', 'openalex'] },
        },
        distinct: ['sourceProvider'],
        orderBy: { createdAt: 'desc' },
      });
    });

    it('skips fetching heavy notesList JSON in CommandRepository.update when notes are not being updated', async () => {
      const userId = '88888888-8888-4888-8888-888888888888';
      const itemId = '99999999-9999-4999-8999-999999999999';
      const mockFindFirst = jest.fn(async () => ({
        id: itemId,
        userId,
        projectId: null,
        version: 1,
        title: 'Old Title',
        itemType: 'journalArticle',
        metadata: {},
        contributors: [],
        identifiers: [],
      }));
      const mockUpdate = jest.fn(async () => ({
        id: itemId,
        userId,
        version: 2,
        title: 'New Title',
      }));
      const mockPrisma = {
        item: {
          findFirst: mockFindFirst,
          update: mockUpdate,
          updateMany: jest.fn(async () => ({ count: 1 })),
          findMany: jest.fn(async () => []),
        },
        itemIdentifier: {
          deleteMany: jest.fn(async () => ({ count: 0 })),
          upsert: jest.fn(async () => ({})),
        },
      };
      const repo = new CommandRepository(mockPrisma as never);

      await repo.update(userId, itemId, 1, { title: 'New Title' });

      const findFirstArg = mockFindFirst.mock.calls[0]?.[0] as {
        include?: Record<string, unknown>;
      };
      expect(findFirstArg.include?.notesList).toBeUndefined();
    });

    it('reuses preloaded collectionItems during executeCopyCollectionSubtree instead of N+1 findItemIdsByCollection queries', async () => {
      const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const rootId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const childId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const mockFindItemIdsByCollection = jest.fn(async () => ['fallback']);
      const mockAddItemsToCollection = jest.fn(async () => {});
      let seq = 0;
      const rootNode = {
        id: rootId,
        name: 'Root',
        parentId: null,
        projectId: null,
        collectionItems: [{ itemId: 'item-1' }, { itemId: 'item-2' }],
      };
      const childNode = {
        id: childId,
        name: 'Child',
        parentId: rootId,
        projectId: null,
        collectionItems: [{ itemId: 'item-3' }],
      };
      const mockRepo = {
        findById: jest.fn(async () => rootNode),
        findAll: jest.fn(async () => [rootNode, childNode]),
        create: jest.fn(async (_u: string, data: { name: string; parentId?: string }) => ({
          id: `cloned-${++seq}`,
          name: data.name,
          parentId: data.parentId ?? null,
          version: 1,
        })),
        findItemIdsByCollection: mockFindItemIdsByCollection,
        addItemsToCollection: mockAddItemsToCollection,
      };

      const res = await executeCopyCollectionSubtree(
        mockRepo as never,
        new TreeEngine(),
        undefined,
        userId,
        rootId,
      );

      expect(res.copiedCount).toBe(2);
      expect(mockFindItemIdsByCollection).not.toHaveBeenCalled();
      expect(mockAddItemsToCollection).toHaveBeenCalledTimes(2);
      expect(res.affectedItemIds).toEqual(['item-1', 'item-2', 'item-3']);
    });

    it('purges expired libraryChange and tombstone rows in parallel in ChangeLogRepository.compactAndPurgeChangeLog', async () => {
      const mockPrisma = {
        libraryChange: {
          findMany: jest.fn(async () => [{ id: 'lc-1' }, { id: 'lc-2' }]),
          deleteMany: jest.fn(async () => ({ count: 2 })),
        },
        tombstone: {
          findMany: jest.fn(async () => [{ id: 'tb-1' }]),
          deleteMany: jest.fn(async () => ({ count: 1 })),
        },
      };
      const repo = new ChangeLogRepository(mockPrisma as never);

      const res = await repo.compactAndPurgeChangeLog(30, 500);

      expect(res).toEqual({ purgedChanges: 2, purgedTombstones: 1 });
      expect(mockPrisma.libraryChange.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['lc-1', 'lc-2'] } },
      });
      expect(mockPrisma.tombstone.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['tb-1'] } },
      });
    });
  });
});
