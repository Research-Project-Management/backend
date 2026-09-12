import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CollectionsService } from '../../src/modules/library/collections/collections.service';
import { CollectionsRepository } from '../../src/modules/library/collections/collections.repository';
import { PrismaService } from '../../src/core/database/prisma.service';
import { TreeEngine } from '../../src/modules/library/collections/engines/tree.engine';

describe('CollectionsService - Two-Tier Zero-Workspace Isolation', () => {
  let service: CollectionsService;
  let repo: jest.Mocked<CollectionsRepository>;
  let prisma: any;

  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const collectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const itemId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeEach(async () => {
    const mockRepo = {
      findAll: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      addItems: jest.fn(),
      removeItem: jest.fn(),
      reorder: jest.fn(),
      findItemIdsByCollection: jest.fn(),
    };

    const mockPrisma = {
      collection: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      item: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionsService,
        { provide: CollectionsRepository, useValue: mockRepo },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TreeEngine, useValue: new TreeEngine() },
      ],
    }).compile();

    service = module.get<CollectionsService>(CollectionsService);
    repo = module.get(CollectionsRepository);
    prisma = module.get(PrismaService);

    jest.clearAllMocks();
  });

  describe('getCollections', () => {
    it('retrieves user collections with item counts mapped', async () => {
      const mockCols = [
        {
          id: collectionId,
          name: 'Quantum Computing',
          userId,
          _count: { collectionItems: 5 },
        },
      ];
      repo.findAll.mockResolvedValue(mockCols as any);

      const result = await service.getCollections(userId);

      expect(repo.findAll).toHaveBeenCalledWith(userId);
      expect(result.total).toBe(1);
      expect(result.collections[0].itemCount).toBe(5);
    });
  });

  describe('assignItemsToCollection', () => {
    it('verifies items belong to user scope before adding to collection', async () => {
      repo.findById.mockResolvedValue({ id: collectionId, userId } as any);
      prisma.item.findMany.mockResolvedValue([{ id: itemId }] as any);
      repo.addItems.mockResolvedValue(undefined as any);

      const result = await service.assignItemsToCollection(userId, collectionId, {
        itemIds: [itemId],
      });

      expect(repo.findById).toHaveBeenCalledWith(userId, collectionId);
      expect(prisma.item.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: [itemId] },
          userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      expect(repo.addItems).toHaveBeenCalledWith(userId, collectionId, [itemId]);
      expect(result).toEqual({ success: true, count: 1 });
    });

    it('throws BadRequestException if any item does not belong to user scope', async () => {
      repo.findById.mockResolvedValue({ id: collectionId, userId } as any);
      prisma.item.findMany.mockResolvedValue([] as any);

      await expect(
        service.assignItemsToCollection(userId, collectionId, {
          itemIds: [itemId],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.addItems).not.toHaveBeenCalled();
    });
  });

  describe('detachItemFromCollection', () => {
    it('verifies item and collection exist and belong to user before removing', async () => {
      repo.findById.mockResolvedValue({ id: collectionId, userId } as any);
      prisma.item.findFirst.mockResolvedValue({ id: itemId, userId } as any);
      repo.removeItem.mockResolvedValue(undefined as any);

      const result = await service.detachItemFromCollection(userId, collectionId, itemId);

      expect(repo.findById).toHaveBeenCalledWith(userId, collectionId);
      expect(prisma.item.findFirst).toHaveBeenCalledWith({
        where: {
          id: itemId,
          userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      expect(repo.removeItem).toHaveBeenCalledWith(userId, collectionId, itemId);
      expect(result).toEqual({ success: true });
    });

    it('throws NotFoundException if collection does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(
        service.detachItemFromCollection(userId, collectionId, itemId),
      ).rejects.toThrow(NotFoundException);
      expect(repo.removeItem).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if item does not exist or belong to user', async () => {
      repo.findById.mockResolvedValue({ id: collectionId, userId } as any);
      prisma.item.findFirst.mockResolvedValue(null);

      await expect(
        service.detachItemFromCollection(userId, collectionId, itemId),
      ).rejects.toThrow(NotFoundException);
      expect(repo.removeItem).not.toHaveBeenCalled();
    });
  });
});
