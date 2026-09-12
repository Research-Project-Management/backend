import { NotFoundException } from '@nestjs/common';
import { ItemsController } from '@/modules/library/items/items.controller';
import { LibraryController } from '@/modules/library/core/library.controller';
import { TypesController } from '@/modules/library/types/types.controller';
import { ItemsService } from '@/modules/library/items/items.service';
import { LibraryService } from '@/modules/library/core/library.service';
import { TypesService } from '@/modules/library/types/types.service';

describe('Library Refactored Scope & Controller Tests (Unit)', () => {
  const PROJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const USER_ID = 'user-1111-1111-1111-111111111111';
  const ITEM_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  describe('ItemsController (Project-Scoped & Personal Access)', () => {
    let controller: ItemsController;
    let itemsService: Partial<ItemsService>;

    beforeEach(() => {
      itemsService = {
        listItems: jest.fn().mockResolvedValue({
          items: [{ id: ITEM_ID, title: 'Deep Learning Review' }],
          meta: { totalCount: 1 },
        }),
        getItem: jest.fn().mockImplementation((projectId, id) => {
          if (id === ITEM_ID) {
            return Promise.resolve({ id: ITEM_ID, title: 'Deep Learning Review' });
          }
          return Promise.resolve(null);
        }),
        getFulltext: jest.fn().mockImplementation((userId, id) => {
          if (id === ITEM_ID) {
            return Promise.resolve({ text: 'Fulltext content...' });
          }
          return Promise.resolve(null);
        }),
        createItem: jest.fn().mockImplementation((userId, data) =>
          Promise.resolve({ id: ITEM_ID, ...data }),
        ),
        updateItem: jest.fn().mockResolvedValue({ id: ITEM_ID, version: 2 }),
        deleteItem: jest.fn().mockResolvedValue(true),
        restoreItem: jest.fn().mockResolvedValue({ id: ITEM_ID, deletedAt: null }),
        purgeItem: jest.fn().mockResolvedValue(true),
        getRelatedItems: jest.fn().mockResolvedValue({ relatedItems: [], total: 0 }),
        linkItems: jest.fn().mockResolvedValue({ success: true }),
        unlinkItems: jest.fn().mockResolvedValue({ success: true, unlinked: true }),
      };

      controller = new ItemsController(itemsService as ItemsService);
    });

    it('listItems routes correctly to itemsService.listItems with userId and query', async () => {
      const result = await controller.listItems(USER_ID, {
        limit: 20,
      } as any);

      expect(itemsService.listItems).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ limit: 20 }),
      );
      expect(result.items).toHaveLength(1);
    });

    it('getItem returns found item or throws NotFoundException', async () => {
      const found = await controller.getItem(ITEM_ID, USER_ID);
      expect(found).toEqual(expect.objectContaining({ id: ITEM_ID }));

      await expect(
        controller.getItem('non-existent', USER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('createItem dispatches with current userId and item data', async () => {
      const body = { title: 'New Paper' } as any;
      const result = await controller.createItem(USER_ID, undefined, body);

      expect(itemsService.createItem).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ title: 'New Paper', uploadedById: USER_ID }),
      );
      expect(result).toHaveProperty('id', ITEM_ID);
    });

    it('deleteItem and purgeItem invoke itemsService with userId and itemId', async () => {
      const deleteResult = await controller.deleteItem(
        ITEM_ID,
        USER_ID,
        undefined,
      );
      expect(itemsService.deleteItem).toHaveBeenCalledWith(
        USER_ID,
        ITEM_ID,
        undefined,
      );
      expect(deleteResult.deleted).toBe(true);

      const purgeResult = await controller.purgeItem(ITEM_ID, USER_ID);
      expect(itemsService.purgeItem).toHaveBeenCalledWith(USER_ID, ITEM_ID);
      expect(purgeResult.purged).toBe(true);
    });

    it('listItems routes correctly with projectId when specified', async () => {
      await controller.listItems(USER_ID, { limit: 10 } as any, PROJECT_ID);

      expect(itemsService.listItems).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ limit: 10, projectId: PROJECT_ID }),
      );
    });

    it('importItems delegates to itemsService.importItemsToProject with userId, projectId, and itemIds', async () => {
      itemsService.importItemsToProject = jest.fn().mockResolvedValue({
        importedCount: 2,
        items: [{ id: 'item-1' }, { id: 'item-2' }],
      });

      const result = await controller.importItems(USER_ID, PROJECT_ID, {
        itemIds: ['item-1', 'item-2'],
      });

      expect(itemsService.importItemsToProject).toHaveBeenCalledWith(
        USER_ID,
        PROJECT_ID,
        ['item-1', 'item-2'],
      );
      expect(result.importedCount).toBe(2);
    });
  });

  describe('LibraryController (Stats & Overview)', () => {
    let controller: LibraryController;
    let libraryService: Partial<LibraryService>;

    beforeEach(() => {
      libraryService = {
        getLibraryStats: jest.fn().mockResolvedValue({
          itemsCount: 42,
          collectionsCount: 3,
          tagsCount: 10,
          notesCount: 5,
          attachmentsCount: 15,
        }),
        getLibraryOverview: jest.fn().mockResolvedValue({
          recentItems: [],
          unfiledCount: 2,
          trashCount: 0,
          starredCount: 1,
          topTags: [],
        }),
        getUserOverview: jest.fn().mockResolvedValue({
          recentItems: [],
          unfiledCount: 0,
          trashCount: 0,
          starredCount: 0,
          topTags: [],
        }),
      };

      controller = new LibraryController(libraryService as LibraryService);
    });

    it('getProjectStats delegates to libraryService.getLibraryStats with projectId', async () => {
      const stats = await controller.getProjectStats(PROJECT_ID);
      expect(libraryService.getLibraryStats).toHaveBeenCalledWith(PROJECT_ID);
      expect(stats.itemsCount).toBe(42);
    });

    it('getProjectOverview delegates with projectId and userId', async () => {
      const overview = await controller.getProjectOverview(PROJECT_ID, USER_ID);
      expect(libraryService.getLibraryOverview).toHaveBeenCalledWith(
        PROJECT_ID,
        USER_ID,
      );
      expect(overview.unfiledCount).toBe(2);
    });

    it('getUserOverview calls user personal overview or delegates to project if specified', async () => {
      await controller.getUserOverview(USER_ID, undefined);
      expect(libraryService.getUserOverview).toHaveBeenCalledWith(USER_ID);

      await controller.getUserOverview(USER_ID, PROJECT_ID);
      expect(libraryService.getLibraryOverview).toHaveBeenCalledWith(
        PROJECT_ID,
        USER_ID,
      );
    });
  });

  describe('TypesController (Static Item Types Registry)', () => {
    let controller: TypesController;
    let typesService: TypesService;

    beforeEach(() => {
      typesService = new TypesService();
      controller = new TypesController(typesService);
    });

    it('listAllItemTypes returns registry version and types list', () => {
      const result = controller.listAllItemTypes();
      expect(result.success).toBe(true);
      expect(result.itemTypes.length).toBeGreaterThan(0);
      expect(result.registryVersion).toBeDefined();
    });

    it('getItemTypeDefinition returns definition or throws NotFoundException', () => {
      const article = controller.getItemTypeDefinition('journalArticle');
      expect(article.success).toBe(true);
      expect(article.itemType.itemType).toBe('journalArticle');

      expect(() => controller.getItemTypeDefinition('unknown-xyz-type')).toThrow(
        NotFoundException,
      );
    });
  });
});
