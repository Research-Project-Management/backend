import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CollectionsService } from '@/modules/library/catalog/services/collections.service';
import { CollectionsRepository } from '@/modules/library/catalog/repositories/collections.repository';
import { executeCopyCollectionSubtree } from '@/modules/library/catalog/repositories/collection-members.repository';
import {
  TreeEngine,
  sanitizeCollectionName,
  sanitizeCollectionDescription,
} from '@/modules/library/catalog/domain/state.domain';

describe('Library Collections — Sanitization, Tree Invariants & Subtree Operations', () => {
  const mockUserId = '11111111-1111-4111-8111-111111111111';
  const mockProjectId = '22222222-2222-4222-8222-222222222222';

  describe('Collection Sanitization', () => {
    it('strips script tags and HTML, handles empty inputs, and enforces length caps', () => {
      expect(
        sanitizeCollectionName(
          '<script>alert(1)</script><b>Quantum Machine Learning</b>',
        ),
      ).toBe('Quantum Machine Learning');
      expect(sanitizeCollectionName('')).toBe('');
      expect(sanitizeCollectionName('   ')).toBe('');
      expect(sanitizeCollectionName(null)).toBe('');
      expect(sanitizeCollectionName('<script>alert("xss")</script>')).toBe('');
      expect(sanitizeCollectionName('C'.repeat(300))).toHaveLength(255);

      expect(
        sanitizeCollectionDescription(
          '<script>bad()</script>Notes on transformer architectures',
        ),
      ).toBe('Notes on transformer architectures');
      expect(sanitizeCollectionDescription('D'.repeat(1200))).toHaveLength(
        1000,
      );
    });
  });

  describe('TreeEngine', () => {
    const treeEngine = new TreeEngine();

    it('detects direct and multi-level cycles while permitting valid reparenting', () => {
      expect(treeEngine.detectCycle([], 'col-1', 'col-1')).toBe(true);
      expect(() => treeEngine.assertNoCycle([], 'col-1', 'col-1')).toThrow(
        BadRequestException,
      );

      const chain = [
        { id: 'col-A', name: 'A', parentId: null },
        { id: 'col-B', name: 'B', parentId: 'col-A' },
        { id: 'col-C', name: 'C', parentId: 'col-B' },
      ];
      expect(treeEngine.detectCycle(chain, 'col-A', 'col-C')).toBe(true);
      expect(() => treeEngine.assertNoCycle(chain, 'col-A', 'col-C')).toThrow(
        BadRequestException,
      );
      expect(treeEngine.detectCycle(chain, 'col-C', 'col-A')).toBe(false);
    });

    it('builds hierarchical trees and deduplicates recursiveItemCount across parent/child overlap', () => {
      const collections = [
        {
          id: 'col-parent',
          name: 'Parent',
          parentId: null,
          _count: { collectionItems: 2 },
          collectionItems: [{ itemId: 'item-shared' }, { itemId: 'item-p1' }],
        },
        {
          id: 'col-child',
          name: 'Child',
          parentId: 'col-parent',
          _count: { collectionItems: 2 },
          collectionItems: [{ itemId: 'item-shared' }, { itemId: 'item-c1' }],
        },
      ];
      const tree = treeEngine.buildTree(collections);
      expect(tree).toHaveLength(1);
      expect(tree[0].itemCount).toBe(2);
      expect(tree[0].children[0].itemCount).toBe(2);
      expect(tree[0].recursiveItemCount).toBe(3);
    });

    it('returns descendants in BFS order and terminates safely on cyclic data', () => {
      const hierarchy = [
        { id: 'root', parentId: null },
        { id: 'child-1', parentId: 'root' },
        { id: 'child-2', parentId: 'root' },
        { id: 'grandchild-1', parentId: 'child-1' },
      ];
      expect(treeEngine.getDescendantIds(hierarchy, 'root')).toEqual([
        'child-1',
        'child-2',
        'grandchild-1',
      ]);

      const cyclic = [
        { id: 'A', parentId: 'B' },
        { id: 'B', parentId: 'A' },
      ];
      expect(treeEngine.getDescendantIds(cyclic, 'A')).toEqual(['B']);
    });
  });

  describe('CollectionsService & Subtree Copy', () => {
    it('validates names, sanitizes inputs, and rejects circular parent updates', async () => {
      const mockRepo = {
        findAll: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };
      const service = new CollectionsService(
        mockRepo as unknown as CollectionsRepository,
        new TreeEngine(),
      );

      await expect(
        service.createCollection(mockUserId, { name: '   ' }),
      ).rejects.toThrow(UnprocessableEntityException);

      mockRepo.create.mockResolvedValue({
        id: 'col-new',
        name: 'Neural Models',
        description: 'Clean description',
        parentId: null,
      });
      const created = await service.createCollection(mockUserId, {
        name: '<script>evil()</script>Neural Models',
        description: '<b>Clean</b> description',
      });
      expect(created.collection).toBeDefined();
      expect(mockRepo.create).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({
          name: 'Neural Models',
          description: 'Clean description',
        }),
      );

      mockRepo.findById
        .mockResolvedValueOnce({ id: 'col-A', name: 'A', parentId: null })
        .mockResolvedValueOnce({ id: 'col-B', name: 'B', parentId: 'col-A' });
      mockRepo.findAll.mockResolvedValue([
        { id: 'col-A', name: 'A', parentId: null },
        { id: 'col-B', name: 'B', parentId: 'col-A' },
      ]);

      await expect(
        service.updateCollection(mockUserId, 'col-A', { parentId: 'col-B' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('cascades collection deletion across subcollections with batched tombstones and outbox events', async () => {
      const mockRecordTombstonesBatch = jest.fn().mockResolvedValue(3);
      const mockAppendChangesBatch = jest.fn().mockResolvedValue(3);
      const mockPublishOutbox = jest.fn().mockResolvedValue({});

      const txMock = {
        executeInTransaction: jest.fn(
          async (op: (tx: unknown, h: Record<string, unknown>) => unknown) =>
            op(
              {},
              {
                recordTombstonesBatch: mockRecordTombstonesBatch,
                appendChangesBatch: mockAppendChangesBatch,
                recordTombstone: jest.fn(),
                appendChange: jest.fn(),
                publishOutbox: mockPublishOutbox,
              },
            ),
        ),
      };

      const cascadeRepo = {
        findById: jest
          .fn()
          .mockResolvedValue({ id: 'col-root', name: 'Root', parentId: null }),
        findAll: jest.fn().mockResolvedValue([
          { id: 'col-root', name: 'Root', parentId: null },
          { id: 'col-sub-1', name: 'Sub 1', parentId: 'col-root' },
          { id: 'col-sub-2', name: 'Sub 2', parentId: 'col-sub-1' },
        ]),
        findItemIdsByCollection: jest.fn().mockResolvedValue(['item-root-1']),
        findItemIdsByCollections: jest
          .fn()
          .mockResolvedValue(['item-sub-1', 'item-sub-2']),
        delete: jest.fn().mockResolvedValue(true),
      };

      const service = new CollectionsService(
        cascadeRepo as unknown as CollectionsRepository,
        new TreeEngine(),
        undefined,
        txMock as never,
      );

      await service.deleteCollection(mockUserId, 'col-root', 'cascade');

      expect(mockRecordTombstonesBatch).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUserId }),
        [
          { entityType: 'Collection', entityId: 'col-root' },
          { entityType: 'Collection', entityId: 'col-sub-1' },
          { entityType: 'Collection', entityId: 'col-sub-2' },
        ],
      );
      expect(mockPublishOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockUserId }),
        'col-root',
        expect.any(String),
        expect.objectContaining({
          deletedCollectionIds: ['col-root', 'col-sub-1', 'col-sub-2'],
          deletedItemIds: ['item-root-1', 'item-sub-1', 'item-sub-2'],
        }),
      );
    });

    it('coalesces concurrent getCollections calls via single-flight and copies subtrees without N+1 queries', async () => {
      const findAllSlow = jest.fn(
        () =>
          new Promise<Array<{ id: string; name: string; parentId: null }>>(
            (resolve) =>
              setTimeout(
                () => resolve([{ id: 'c1', name: 'Root', parentId: null }]),
                1,
              ),
          ),
      );
      const service = new CollectionsService({
        findAll: findAllSlow,
      } as unknown as CollectionsRepository);

      await Promise.all(
        Array.from({ length: 25 }, () =>
          service.getCollections(mockUserId, mockProjectId),
        ),
      );
      expect(findAllSlow).toHaveBeenCalledTimes(1);

      let seq = 0;
      const rootNode = {
        id: 'col-root',
        name: 'Root',
        parentId: null,
        projectId: null,
        collectionItems: [{ itemId: 'item-1' }, { itemId: 'item-2' }],
      };
      const childNode = {
        id: 'col-child',
        name: 'Child',
        parentId: 'col-root',
        projectId: null,
        collectionItems: [{ itemId: 'item-3' }],
      };
      const findItemIdsByCollection = jest.fn();
      const addItemsToCollection = jest.fn().mockResolvedValue(undefined);

      const copyRes = await executeCopyCollectionSubtree(
        {
          findById: jest.fn().mockResolvedValue(rootNode),
          findAll: jest.fn().mockResolvedValue([rootNode, childNode]),
          create: jest.fn(
            async (_u: string, data: { name: string; parentId?: string }) => ({
              id: `cloned-${++seq}`,
              name: data.name,
              parentId: data.parentId ?? null,
              version: 1,
            }),
          ),
          findItemIdsByCollection,
          addItemsToCollection,
        } as never,
        new TreeEngine(),
        undefined,
        mockUserId,
        'col-root',
      );

      expect(copyRes.copiedCount).toBe(2);
      expect(copyRes.affectedItemIds).toEqual(['item-1', 'item-2', 'item-3']);
      expect(findItemIdsByCollection).not.toHaveBeenCalled();
    });
  });
});
