import { DoiVo } from '../../src/modules/library/bibliography/domain/value-objects/doi.vo';
import { CitationKeyVo } from '../../src/modules/library/bibliography/domain/value-objects/citation-key.vo';
import { ItemAggregate } from '../../src/modules/library/bibliography/domain/model/item.aggregate';
import {
  ItemConcurrencyDomainException,
  ItemValidationDomainException,
} from '../../src/modules/library/bibliography/domain/exceptions/item-domain.exception';
import { CreateItemUseCase } from '../../src/modules/library/bibliography/application/commands/create-item/create-item.use-case';
import { UpdateItemUseCase } from '../../src/modules/library/bibliography/application/commands/update-item/update-item.use-case';
import { DeleteItemUseCase } from '../../src/modules/library/bibliography/application/commands/delete-item/delete-item.use-case';
import { RestoreItemUseCase } from '../../src/modules/library/bibliography/application/commands/restore-item/restore-item.use-case';
import { GetItemUseCase } from '../../src/modules/library/bibliography/application/queries/get-item/get-item.use-case';
import { ListItemsUseCase } from '../../src/modules/library/bibliography/application/queries/list-items/list-items.use-case';
import { IItemRepositoryPort } from '../../src/modules/library/bibliography/domain/ports/item-repository.port';

describe('Catalog Bounded Context - Clean Architecture & DDD', () => {
  describe('Value Objects', () => {
    it('DoiVo should validate and normalize DOIs to lowercase', () => {
      const doi = DoiVo.create('https://doi.org/10.1000/182.XYZ');
      expect(doi).not.toBeNull();
      expect(doi?.value).toBe('10.1000/182.xyz');

      const doi2 = DoiVo.create('10.1000/182.xyz');
      expect(doi?.equals(doi2)).toBe(true);

      expect(() => DoiVo.create('invalid-doi')).toThrow();
      expect(DoiVo.create(null)).toBeNull();
    });

    it('CitationKeyVo should validate BibTeX citation keys', () => {
      const key = CitationKeyVo.create('Einstein1905_relativity');
      expect(key).not.toBeNull();
      expect(key?.value).toBe('Einstein1905_relativity');

      expect(() => CitationKeyVo.create('invalid key with spaces')).toThrow();
      expect(CitationKeyVo.create(undefined)).toBeNull();
    });
  });

  describe('ItemAggregate Root', () => {
    it('should enforce invariants on creation and record ItemCreatedDomainEvent', () => {
      const item = ItemAggregate.create({
        userId: 'user-1',
        title: 'Special Relativity',
        itemType: 'journalArticle',
        doi: '10.1000/182',
        year: 1905,
      });

      expect(item.id).toBeDefined();
      expect(item.version).toBe(1);
      expect(item.title).toBe('Special Relativity');
      expect(item.doi).toBe('10.1000/182');
      expect(item.isDeleted).toBe(false);

      const events = item.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('catalog.item.created');
      expect(events[0].aggregateId).toBe(item.id);

      // Subsequent pull should be empty (drained)
      expect(item.pullDomainEvents()).toHaveLength(0);
    });

    it('should reject invalid title or itemType', () => {
      expect(() =>
        ItemAggregate.create({
          userId: 'user-1',
          title: '   ',
          itemType: 'journalArticle',
        }),
      ).toThrow(ItemValidationDomainException);

      expect(() =>
        ItemAggregate.create({
          userId: 'user-1',
          title: 'Valid Title',
          itemType: '   ',
        }),
      ).toThrow(ItemValidationDomainException);
    });

    it('should increment version and record event on metadata update', () => {
      const item = ItemAggregate.create({
        userId: 'user-1',
        title: 'Initial Title',
        itemType: 'book',
      });
      item.pullDomainEvents(); // drain creation event

      item.updateMetadata({ title: 'Updated Title', year: 2026 }, 1);

      expect(item.version).toBe(2);
      expect(item.title).toBe('Updated Title');
      expect(item.year).toBe(2026);

      const events = item.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('catalog.item.updated');
    });

    it('should throw ItemConcurrencyDomainException on version mismatch', () => {
      const item = ItemAggregate.create({
        userId: 'user-1',
        title: 'Concurrency Test',
        itemType: 'journalArticle',
      });

      expect(
        () => item.updateMetadata({ title: 'Conflict' }, 999), // expected version mismatch
      ).toThrow(ItemConcurrencyDomainException);
    });

    it('should handle soft deletion and record ItemDeletedDomainEvent', () => {
      const item = ItemAggregate.create({
        userId: 'user-1',
        title: 'To Be Deleted',
        itemType: 'journalArticle',
      });
      item.pullDomainEvents();

      item.softDelete(1);
      expect(item.isDeleted).toBe(true);
      expect(item.version).toBe(2);

      const events = item.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('catalog.item.deleted');

      // Cannot update soft-deleted item without restore
      expect(() => item.updateMetadata({ title: 'Fail' })).toThrow(
        ItemValidationDomainException,
      );

      item.restore();
      expect(item.isDeleted).toBe(false);
      expect(item.version).toBe(3);
    });
  });

  describe('Application Layer (CQRS Use Cases)', () => {
    let mockRepo: jest.Mocked<IItemRepositoryPort>;
    let savedAggregate: ItemAggregate | null = null;

    beforeEach(() => {
      savedAggregate = null;
      mockRepo = {
        save: jest.fn().mockImplementation(async (agg: ItemAggregate) => {
          savedAggregate = agg;
        }),
        findById: jest
          .fn()
          .mockImplementation(async (userId: string, itemId: string) => {
            if (
              savedAggregate &&
              savedAggregate.id === itemId &&
              savedAggregate.userId === userId
            ) {
              return savedAggregate;
            }
            return null;
          }),
        findMany: jest.fn().mockImplementation(async () => {
          return {
            items: savedAggregate ? [savedAggregate] : [],
            totalCount: savedAggregate ? 1 : 0,
            hasNextPage: false,
          };
        }),
        delete: jest.fn().mockResolvedValue(undefined),
        purge: jest.fn().mockResolvedValue(true),
        setMyPublication: jest.fn().mockResolvedValue(null),
        getRelations: jest.fn().mockResolvedValue([]),
        putRelation: jest.fn().mockResolvedValue({ id: 'rel-1' }),
        removeRelation: jest.fn().mockResolvedValue(true),
      };
    });

    it('CreateItemUseCase should instantiate aggregate and call repo.save', async () => {
      const useCase = new CreateItemUseCase(mockRepo);
      const result = await useCase.execute({
        userId: 'user-1',
        title: 'Clean Architecture in Practice',
        itemType: 'book',
        doi: '10.1234/5678',
        year: 2026,
      });

      expect(mockRepo.save).toHaveBeenCalledTimes(1);
      expect(result.id).toBeDefined();
      expect(result.title).toBe('Clean Architecture in Practice');
      expect(result.version).toBe(1);
      expect(result.doi).toBe('10.1234/5678');
    });

    it('UpdateItemUseCase should load aggregate, apply changes, and persist', async () => {
      // Seed an initial aggregate
      const initial = ItemAggregate.create({
        userId: 'user-1',
        title: 'Original Title',
        itemType: 'journalArticle',
      });
      savedAggregate = initial;

      const updateUseCase = new UpdateItemUseCase(mockRepo);
      const result = await updateUseCase.execute({
        userId: 'user-1',
        itemId: initial.id,
        expectedVersion: 1,
        changes: {
          title: 'Modified Title',
        },
      });

      expect(mockRepo.save).toHaveBeenCalledTimes(1);
      expect(result.title).toBe('Modified Title');
      expect(result.version).toBe(2);
    });

    it('GetItemUseCase should return null for deleted items', async () => {
      const initial = ItemAggregate.create({
        userId: 'user-1',
        title: 'Deleted Item',
        itemType: 'journalArticle',
      });
      initial.softDelete();
      savedAggregate = initial;

      const getUseCase = new GetItemUseCase(mockRepo);
      const result = await getUseCase.execute({
        userId: 'user-1',
        itemId: initial.id,
      });

      expect(result).toBeNull();
    });

    it('ListItemsUseCase should delegate to repo.findMany and return PaginatedItemsDto', async () => {
      const initial = ItemAggregate.create({
        userId: 'user-1',
        title: 'Paginated Item',
        itemType: 'conferencePaper',
      });
      savedAggregate = initial;

      const listUseCase = new ListItemsUseCase(mockRepo);
      const result = await listUseCase.execute({
        userId: 'user-1',
        limit: 10,
      });

      expect(mockRepo.findMany).toHaveBeenCalledTimes(1);
      expect(result.items.length).toBe(1);
      expect(result.items[0].title).toBe('Paginated Item');
      expect(result.pagination.totalCount).toBe(1);
    });

    it('RestoreItemUseCase should restore a soft-deleted item and increment version', async () => {
      const initial = ItemAggregate.create({
        userId: 'user-1',
        title: 'Trashed Item',
        itemType: 'journalArticle',
      });
      initial.softDelete(1);
      expect(initial.isDeleted).toBe(true);
      savedAggregate = initial;

      const restoreUseCase = new RestoreItemUseCase(mockRepo);
      const result = await restoreUseCase.execute({
        userId: 'user-1',
        itemId: initial.id,
      });

      expect(mockRepo.save).toHaveBeenCalledTimes(1);
      expect(result.isDeleted).toBe(false);
      expect(result.version).toBe(3);
    });
  });
});
