import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ItemsController } from '../../src/modules/library/bibliography/presentation/items.controller';
import { CreateItemUseCase } from '../../src/modules/library/bibliography/application/commands/create-item/create-item.use-case';
import { UpdateItemUseCase } from '../../src/modules/library/bibliography/application/commands/update-item/update-item.use-case';
import { DeleteItemUseCase } from '../../src/modules/library/bibliography/application/commands/delete-item/delete-item.use-case';
import { RestoreItemUseCase } from '../../src/modules/library/bibliography/application/commands/restore-item/restore-item.use-case';
import { GetItemUseCase } from '../../src/modules/library/bibliography/application/queries/get-item/get-item.use-case';
import { ListItemsUseCase } from '../../src/modules/library/bibliography/application/queries/list-items/list-items.use-case';
import {
  ItemConcurrencyDomainException,
  ItemNotFoundDomainException,
} from '../../src/modules/library/bibliography/domain/exceptions/item-domain.exception';
import { VersionMismatchException } from '../../src/modules/library/shared-kernel/core/errors/version-mismatch.exception';

describe('ItemsController (Hexagonal Driver Adapter)', () => {
  let controller: ItemsController;
  let mockCreateUseCase: { execute: jest.Mock };
  let mockUpdateUseCase: { execute: jest.Mock };
  let mockDeleteUseCase: { execute: jest.Mock };
  let mockRestoreUseCase: { execute: jest.Mock };
  let mockGetUseCase: { execute: jest.Mock };
  let mockListUseCase: { execute: jest.Mock };

  const validUuid = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    mockCreateUseCase = {
      execute: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Hexagonal Design in NestJS',
        itemType: 'journalArticle',
        version: 1,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    mockUpdateUseCase = {
      execute: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Updated Title',
        itemType: 'journalArticle',
        version: 2,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    mockDeleteUseCase = {
      execute: jest.fn().mockResolvedValue(undefined),
    };
    mockRestoreUseCase = {
      execute: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Restored Title',
        itemType: 'journalArticle',
        version: 2,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    mockGetUseCase = {
      execute: jest.fn().mockResolvedValue({
        id: validUuid,
        userId: 'user-1',
        title: 'Sample Item',
        itemType: 'book',
        version: 1,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    };
    mockListUseCase = {
      execute: jest.fn().mockResolvedValue({
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
        pagination: { hasNextPage: false, totalCount: 1 },
      }),
    };

    controller = new ItemsController(
      mockCreateUseCase as any,
      mockUpdateUseCase as any,
      mockDeleteUseCase as any,
      mockRestoreUseCase as any,
      mockGetUseCase as any,
      mockListUseCase as any,
      // Query & Command Use Cases
      {
        execute: jest.fn().mockResolvedValue({
          title: '',
          sections: [],
          figures: [],
          tables: [],
          formulas: [],
          references: [],
        }),
      } as any,
      {
        execute: jest.fn().mockResolvedValue({ references: [], count: 0 }),
      } as any,
      {
        execute: jest.fn().mockResolvedValue({
          success: true,
          message: 'reindexed',
          itemId: validUuid,
        }),
      } as any,
      {
        execute: jest
          .fn()
          .mockResolvedValue({ success: true, item: {}, conversionReport: {} }),
      } as any,
      {
        execute: jest.fn().mockResolvedValue({ success: true, importedCount: 0 }),
      } as any,
      {
        execute: jest.fn().mockResolvedValue(true),
      } as any,
      {
        execute: jest.fn().mockResolvedValue({ id: validUuid }),
      } as any,
      {
        getRelatedItems: jest.fn().mockResolvedValue({ relatedItems: [], total: 0 }),
        linkItems: jest.fn().mockResolvedValue({ success: true }),
        unlinkItems: jest.fn().mockResolvedValue({ success: true }),
      } as any,
      {
        execute: jest.fn().mockReturnValue({ targetType: 'book', fields: {} }),
      } as any,
    );
  });

  it('should list items by delegating to ListItemsUseCase', async () => {
    const result = await controller.listItems('user-1', { view: 'all' });
    expect(mockListUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', view: 'all' }),
    );
    expect(result.items.length).toBe(1);
    expect(result.pagination.totalCount).toBe(1);
  });

  it('should get item by delegating to GetItemUseCase', async () => {
    const result = await controller.getItem(validUuid, 'user-1');
    expect(mockGetUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      projectId: undefined,
    });
    expect(result.id).toBe(validUuid);
  });

  it('should throw NotFoundException if item is not found or deleted', async () => {
    mockGetUseCase.execute?.mockResolvedValueOnce(null);
    await expect(controller.getItem(validUuid, 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should create item by delegating to CreateItemUseCase with tracing headers', async () => {
    const result = await controller.createItem(
      'user-1',
      undefined,
      { title: 'New Item', itemType: 'journalArticle' },
      'idemp-123',
      'corr-456',
    );
    expect(mockCreateUseCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        title: 'New Item',
        itemType: 'journalArticle',
        idempotencyKey: 'idemp-123',
        correlationId: 'corr-456',
      }),
    );
    expect(result.id).toBe(validUuid);
  });

  it('should update item and translate ItemConcurrencyDomainException to VersionMismatchException', async () => {
    mockUpdateUseCase.execute?.mockRejectedValueOnce(
      new ItemConcurrencyDomainException(validUuid, 2, 1),
    );

    await expect(
      controller.updateItem(validUuid, 'user-1', '1', {
        expectedVersion: 1,
        title: 'Conflicting Change',
      } as any),
    ).rejects.toThrow(VersionMismatchException);
  });

  it('should soft delete item by delegating to DeleteItemUseCase', async () => {
    const result = await controller.deleteItem(validUuid, 'user-1', '1');
    expect(mockDeleteUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      expectedVersion: 1,
      projectId: undefined,
      correlationId: undefined,
    });
    expect(result).toEqual({ success: true, deleted: true, id: validUuid });
  });

  it('should restore item by delegating to RestoreItemUseCase', async () => {
    const result = await controller.restoreItem(validUuid, 'user-1', '2');
    expect(mockRestoreUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      expectedVersion: 2,
      projectId: undefined,
      correlationId: undefined,
    });
    expect(result.success).toBe(true);
    expect(result.item.id).toBe(validUuid);
  });
});
