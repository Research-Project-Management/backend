import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CollectionsService } from '@/modules/library/collections/collections.service';
import { CollectionsRepository } from '@/modules/library/collections/collections.repository';
import { TagsService } from '@/modules/library/tags/tags.service';
import { TagsRepository } from '@/modules/library/tags/tags.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { TransactionService } from '@/modules/library/outbox/transaction.service';

describe('Library Multi-Tenant Security & Batch Insertion Tests', () => {
  const WORKSPACE_A = '11111111-1111-1111-1111-111111111111';
  const WORKSPACE_B = '22222222-2222-2222-2222-222222222222';
  const COLLECTION_ID = '33333333-3333-3333-3333-333333333333';
  const ITEM_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ITEM_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const TAG_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  describe('CollectionsService — IDOR/BOLA Protection & Batch Insert', () => {
    let collectionsService: CollectionsService;
    let collectionsRepo: Partial<CollectionsRepository>;
    let prisma: Partial<PrismaService>;

    beforeEach(() => {
      collectionsRepo = {
        findById: jest.fn().mockImplementation((wsId, colId) => {
          if (wsId === WORKSPACE_A && colId === COLLECTION_ID) {
            return Promise.resolve({
              id: COLLECTION_ID,
              workspaceId: WORKSPACE_A,
              name: 'Research',
            } as any);
          }
          return Promise.resolve(null);
        }),
        addItems: jest.fn().mockResolvedValue(undefined),
        removeItem: jest.fn().mockResolvedValue(undefined),
      };

      prisma = {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: WORKSPACE_A }),
        } as any,
        item: {
          findMany: jest.fn().mockImplementation(({ where }) => {
            const requestedIds: string[] = where.id?.in || [];
            // Only ITEM_A belongs to WORKSPACE_A
            const found = [];
            if (
              where.workspaceId === WORKSPACE_A &&
              requestedIds.includes(ITEM_A)
            ) {
              found.push({ id: ITEM_A });
            }
            return Promise.resolve(found);
          }),
          findFirst: jest.fn().mockImplementation(({ where }) => {
            if (where.workspaceId === WORKSPACE_A && where.id === ITEM_A) {
              return Promise.resolve({ id: ITEM_A });
            }
            return Promise.resolve(null);
          }),
        } as any,
      };

      collectionsService = new CollectionsService(
        collectionsRepo as CollectionsRepository,
        prisma as PrismaService,
      );
    });

    it('rejects adding item from Workspace B into Collection in Workspace A', async () => {
      await expect(
        collectionsService.assignItemsToCollection(WORKSPACE_A, COLLECTION_ID, {
          itemIds: [ITEM_B],
        }),
      ).rejects.toThrow(BadRequestException);

      expect(collectionsRepo.addItems).not.toHaveBeenCalled();
    });

    it('successfully batch adds valid workspace items without sequential looping', async () => {
      const res = await collectionsService.assignItemsToCollection(
        WORKSPACE_A,
        COLLECTION_ID,
        { itemIds: [ITEM_A] },
      );

      expect(res).toEqual({ success: true, count: 1 });
      expect(collectionsRepo.addItems).toHaveBeenCalledTimes(1);
      expect(collectionsRepo.addItems).toHaveBeenCalledWith(
        WORKSPACE_A,
        COLLECTION_ID,
        [ITEM_A],
      );
    });

    it('rejects detaching item that does not belong to the workspace', async () => {
      await expect(
        collectionsService.detachItemFromCollection(
          WORKSPACE_A,
          COLLECTION_ID,
          ITEM_B,
        ),
      ).rejects.toThrow(NotFoundException);

      expect(collectionsRepo.removeItem).not.toHaveBeenCalled();
    });
  });

  describe('TagsService — IDOR/BOLA Isolation', () => {
    let tagsService: TagsService;
    let tagsRepo: Partial<TagsRepository>;
    let libraryTx: Partial<TransactionService>;
    let mockTx: any;

    beforeEach(() => {
      tagsRepo = {
        assignToItem: jest.fn().mockResolvedValue(undefined),
        removeFromItem: jest.fn().mockResolvedValue(undefined),
      };

      mockTx = {
        tag: {
          findFirst: jest.fn().mockImplementation(({ where }) => {
            if (where.workspaceId === WORKSPACE_A && where.id === TAG_A) {
              return Promise.resolve({ id: TAG_A, workspaceId: WORKSPACE_A });
            }
            return Promise.resolve(null);
          }),
        },
        item: {
          findFirst: jest.fn().mockImplementation(({ where }) => {
            if (where.workspaceId === WORKSPACE_A && where.id === ITEM_A) {
              return Promise.resolve({ id: ITEM_A, workspaceId: WORKSPACE_A });
            }
            return Promise.resolve(null);
          }),
        },
      };

      libraryTx = {
        executeInTransaction: jest.fn().mockImplementation(async (callback) => {
          const helpers = {
            appendChange: jest.fn().mockResolvedValue({} as any),
            publishOutbox: jest.fn().mockResolvedValue({} as any),
            recordTombstone: jest.fn().mockResolvedValue({} as any),
          };
          return callback(mockTx, helpers);
        }),
      };

      tagsService = new TagsService(
        tagsRepo as TagsRepository,
        libraryTx as TransactionService,
      );
    });

    it('rejects assigning tag if tag belongs to another workspace', async () => {
      await expect(
        tagsService.assignTag(WORKSPACE_B, TAG_A, ITEM_A),
      ).rejects.toThrow(NotFoundException);

      expect(tagsRepo.assignToItem).not.toHaveBeenCalled();
    });

    it('rejects assigning tag if catalogItem belongs to another workspace', async () => {
      await expect(
        tagsService.assignTag(WORKSPACE_A, TAG_A, ITEM_B),
      ).rejects.toThrow(NotFoundException);

      expect(tagsRepo.assignToItem).not.toHaveBeenCalled();
    });

    it('allows assigning tag when both tag and catalogItem belong to the workspace', async () => {
      await expect(
        tagsService.assignTag(WORKSPACE_A, TAG_A, ITEM_A),
      ).resolves.not.toThrow();

      expect(tagsRepo.assignToItem).toHaveBeenCalledWith(TAG_A, ITEM_A, mockTx);
    });
  });
});
