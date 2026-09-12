import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TagsService } from '../../src/modules/library/tags/tags.service';
import { TagsRepository } from '../../src/modules/library/tags/tags.repository';
import { TransactionService } from '../../src/modules/library/outbox/transaction.service';
import { PrismaService } from '../../src/core/database/prisma.service';

describe('TagsService - Zero-Workspace Two-Tier Isolation', () => {
  let service: TagsService;
  let repo: jest.Mocked<TagsRepository>;
  let libraryTx: jest.Mocked<TransactionService>;

  const userId = '11111111-1111-4111-8111-111111111111';
  const tagId = '22222222-2222-4222-8222-222222222222';
  const itemId = '33333333-3333-4333-8333-333333333333';

  const mockHelpers = {
    appendChange: jest.fn().mockResolvedValue({}),
    recordTombstone: jest.fn().mockResolvedValue({}),
    publishOutbox: jest.fn().mockResolvedValue({}),
  };

  const mockTx = {
    tag: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      createMany: jest.fn(),
    },
    item: {
      findFirst: jest.fn(),
    },
    itemTag: {
      createMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    const mockRepo = {
      findMany: jest.fn(),
      findByName: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      deleteAutomatic: jest.fn(),
      assignToItem: jest.fn(),
      removeFromItem: jest.fn(),
    };

    const mockTransactionService = {
      executeInTransaction: jest.fn((callback: any) =>
        callback(mockTx, mockHelpers),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagsService,
        { provide: TagsRepository, useValue: mockRepo },
        { provide: TransactionService, useValue: mockTransactionService },
        { provide: PrismaService, useValue: mockTx },
      ],
    }).compile();

    service = module.get<TagsService>(TagsService);
    repo = module.get(TagsRepository);
    libraryTx = module.get(TransactionService);

    jest.clearAllMocks();
  });

  describe('createOrGetTag', () => {
    it('creates tag scoped to userId and appends change log', async () => {
      const mockCreated = {
        id: tagId,
        name: 'Machine Learning',
        color: '#3b82f6',
        type: 'manual',
        userId,
        projectId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      repo.create.mockResolvedValue(mockCreated as any);

      const result = await service.createOrGetTag(userId, 'Machine Learning');

      expect(repo.create).toHaveBeenCalledWith(
        userId,
        'Machine Learning',
        undefined,
        undefined,
        mockTx,
      );
      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: 'Tag',
          entityId: tagId,
          action: 'create',
        }),
      );
      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        userId,
        tagId,
        'library.tag.created',
        mockCreated,
      );
      expect(result).toEqual(mockCreated);
    });
  });

  describe('deleteTag', () => {
    it('deletes tag and creates tombstone record', async () => {
      repo.delete.mockResolvedValue(true);

      const result = await service.deleteTag(userId, tagId);

      expect(repo.delete).toHaveBeenCalledWith(userId, tagId, mockTx);
      expect(mockHelpers.recordTombstone).toHaveBeenCalledWith(userId, {
        entityType: 'Tag',
        entityId: tagId,
      });
      expect(result).toBe(true);
    });
  });

  describe('assignTag', () => {
    it('verifies tag and item both belong to user scope before assigning', async () => {
      mockTx.tag.findFirst.mockResolvedValue({ id: tagId });
      mockTx.item.findFirst.mockResolvedValue({ id: itemId });

      await service.assignTag(userId, tagId, itemId);

      expect(mockTx.tag.findFirst).toHaveBeenCalledWith({
        where: { id: tagId, userId },
        select: { id: true },
      });
      expect(mockTx.item.findFirst).toHaveBeenCalledWith({
        where: { id: itemId, userId, deletedAt: null },
        select: { id: true },
      });
      expect(repo.assignToItem).toHaveBeenCalledWith(tagId, itemId, mockTx);
    });

    it('throws NotFoundException if tag is not owned by user', async () => {
      mockTx.tag.findFirst.mockResolvedValue(null);

      await expect(service.assignTag(userId, tagId, itemId)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.assignToItem).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if item is not owned by user', async () => {
      mockTx.tag.findFirst.mockResolvedValue({ id: tagId });
      mockTx.item.findFirst.mockResolvedValue(null);

      await expect(service.assignTag(userId, tagId, itemId)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.assignToItem).not.toHaveBeenCalled();
    });
  });

  describe('syncTagsToItem', () => {
    it('synchronizes tags with single-query deduplication and creates missing tags', async () => {
      mockTx.tag.findMany
        .mockResolvedValueOnce([{ id: 'existing-tag-1', name: 'neural-networks' }])
        .mockResolvedValueOnce([
          { id: 'existing-tag-1', name: 'neural-networks' },
          { id: 'new-tag-2', name: 'deep-learning' },
        ]);

      await service.syncTagsToItem(
        mockTx as any,
        userId,
        itemId,
        ['neural-networks', 'deep-learning'],
      );

      expect(mockTx.tag.createMany).toHaveBeenCalledWith({
        data: [{ userId, name: 'Deep-Learning' }],
        skipDuplicates: true,
      });
      expect(mockTx.itemTag.createMany).toHaveBeenCalledWith({
        data: [
          { tagId: 'existing-tag-1', itemId },
          { tagId: 'new-tag-2', itemId },
        ],
        skipDuplicates: true,
      });
    });
  });
});
