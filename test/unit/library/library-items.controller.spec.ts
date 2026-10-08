import { NotFoundException } from '@nestjs/common';
import { ItemsController } from '@/modules/library/catalog/controllers/items.controller';
import {
  ItemConcurrencyDomainException,
  ItemNotFoundDomainException,
} from '@/modules/library/catalog/core/domain/item-domain.exception';
import { VersionMismatchException } from '@/modules/library/shared-kernel/core/errors/version-mismatch.exception';

describe('ItemsController (Hexagonal Driver Adapter)', () => {
  let controller: ItemsController;
  let mockItemService: {
    listItems: jest.Mock;
    getItem: jest.Mock;
    createItem: jest.Mock;
    updateItem: jest.Mock;
    deleteItem: jest.Mock;
    restoreItem: jest.Mock;
    getMetadataSources: jest.Mock;
  };

  const validUuid = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    mockItemService = {
      listItems: jest.fn().mockResolvedValue({
        items: [
          {
            id: validUuid,
            userId: 'user-1',
            title: 'Sample Item',
            itemType: 'book',
            version: 1,
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        meta: { hasNextPage: false, totalCount: 1 },
      }),
      getItem: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Sample Item',
        itemType: 'book',
        version: 1,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      createItem: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Hexagonal Design in NestJS',
        itemType: 'journalArticle',
        version: 1,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      updateItem: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Updated Title',
        itemType: 'journalArticle',
        version: 2,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      deleteItem: jest.fn().mockResolvedValue(true),
      restoreItem: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Restored Title',
        itemType: 'journalArticle',
        version: 2,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getMetadataSources: jest.fn().mockResolvedValue({
        count: 1,
        sources: [{ sourceProvider: 'arxiv' }],
      }),
    };

    controller = new ItemsController(mockItemService as any);
  });

  it('should list items by delegating to ItemService', async () => {
    const result = await controller.listItems('user-1', { view: 'all' });
    expect(mockItemService.listItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ view: 'all' }),
    );
    expect(result.items.length).toBe(1);
    expect(result.pagination.totalCount).toBe(1);
  });

  it('should list items by delegating to ItemService with sorting and filters', async () => {
    await controller.listItems('user-1', {
      view: 'all',
      orderBy: 'year',
      orderDirection: 'asc',
      fromYear: 2020,
      toYear: 2024,
      itemType: 'journalArticle',
      readStatus: 'unread',
    });
    expect(mockItemService.listItems).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        view: 'all',
      }),
    );
  });

  it('should get item by delegating to ItemService', async () => {
    const result = await controller.getItem(validUuid, 'user-1');
    expect(mockItemService.getItem).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      undefined,
    );
    expect(result.id).toBe(validUuid);
  });

  it('should throw NotFoundException if item is not found or deleted', async () => {
    mockItemService.getItem.mockResolvedValueOnce(null);
    await expect(controller.getItem(validUuid, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should create item by delegating to ItemService', async () => {
    const result = await controller.createItem(
      'user-1',
      undefined,
      { title: 'New Item', itemType: 'journalArticle' },
      'idemp-123',
      'corr-456',
    );
    expect(mockItemService.createItem).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'New Item',
        itemType: 'journalArticle',
      }),
      expect.objectContaining({
        idempotencyKey: 'idemp-123',
        correlationId: 'corr-456',
      }),
      undefined,
    );
    expect(result.id).toBe(validUuid);
  });

  it('should update item and propagate VersionMismatchException', async () => {
    mockItemService.updateItem.mockRejectedValueOnce(
      new VersionMismatchException(validUuid, 2, 1),
    );

    await expect(
      controller.updateItem(validUuid, 'user-1', '1', {
        expectedVersion: 1,
        title: 'Conflicting Change',
      } as any),
    ).rejects.toThrow(VersionMismatchException);
  });

  it('should soft delete item by delegating to ItemService', async () => {
    const result = await controller.deleteItem(validUuid, 'user-1', '1');
    expect(mockItemService.deleteItem).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      1,
      undefined,
      undefined,
    );
    expect(result).toEqual({ success: true, deleted: true, id: validUuid });
  });

  it('should restore item by delegating to ItemService', async () => {
    const result = await controller.restoreItem(validUuid, 'user-1', '2');
    expect(mockItemService.restoreItem).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      2,
      undefined,
    );
    expect(result.success).toBe(true);
    expect(result.item.id).toBe(validUuid);
  });

  it('should return metadata sources by delegating to ItemService', async () => {
    const result = await controller.getMetadataSources(validUuid, 'user-1');
    expect(mockItemService.getMetadataSources).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      undefined,
    );
    expect(result.count).toBe(1);
    expect(result.sources[0].sourceProvider).toBe('arxiv');
  });
});
