import { ItemsService } from '@/modules/library/bibliography/application/services/items.service';
import { QueryRepository } from '@/modules/library/bibliography/infrastructure/repositories/query.repository';
import { CommandRepository } from '@/modules/library/bibliography/infrastructure/repositories/command.repository';
import { TransactionService } from '@/modules/library/shared-kernel/outbox/transaction.service';
import { TagsService } from '@/modules/library/bibliography/application/services/tags.service';
import { TypesService } from '@/modules/library/bibliography/application/services/types.service';
import { ItemTransformer } from '@/modules/library/bibliography/infrastructure/mappers/item.transformer';
import { RedisCacheService } from '@/core/cache/redis.service';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/shared-kernel/core/constants/redis-keys.constant';

describe('Library Cache-Aside & Multi-tier Invalidation Pattern', () => {
  let service: ItemsService;
  let queryRepo: jest.Mocked<QueryRepository>;
  let commandRepo: jest.Mocked<CommandRepository>;
  let txService: jest.Mocked<TransactionService>;
  let tagsService: jest.Mocked<TagsService>;
  let typesService: jest.Mocked<TypesService>;
  let transformer: ItemTransformer;
  let cache: jest.Mocked<RedisCacheService>;

  const mockUserId = 'user-uuid-1111';
  const mockItemId = 'item-uuid-2222';
  const mockProjectId = 'project-uuid-3333';

  const mockDbItem: any = {
    id: mockItemId,
    userId: mockUserId,
    title: 'Attention Is All You Need',
    itemType: 'journalArticle',
    version: 1,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    contributors: [
      { firstName: 'Ashish', lastName: 'Vaswani', role: 'author', orderIndex: 0 },
    ],
    collectionItems: [],
    itemTags: [],
    notesList: [],
    attachments: [],
  };

  beforeEach(() => {
    queryRepo = {
      findById: jest.fn().mockResolvedValue(mockDbItem),
      findMetadataSourceRecord: jest.fn().mockResolvedValue({
        id: 'meta-1',
        source: 'grobid_fulltext',
        rawPayload: {
          title: 'Attention Is All You Need',
          abstract: 'We propose the Transformer...',
          sections: [{ title: 'Introduction', text: 'Recurrent models...' }],
          figures: [],
          tables: [],
          formulas: [],
          references: [],
        },
      }),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([mockDbItem]),
    } as unknown as jest.Mocked<QueryRepository>;

    commandRepo = {
      create: jest.fn().mockResolvedValue(mockDbItem),
      update: jest.fn().mockResolvedValue({ ...mockDbItem, version: 2, title: 'Updated Title' }),
      softDelete: jest.fn().mockResolvedValue(true),
      restore: jest.fn().mockResolvedValue({ ...mockDbItem, version: 3 }),
      purge: jest.fn().mockResolvedValue(true),
      setMyPublication: jest.fn().mockResolvedValue({ ...mockDbItem, isMyPublication: true, version: 2 }),
    } as unknown as jest.Mocked<CommandRepository>;

    txService = {
      executeInTransaction: jest.fn().mockImplementation(async (callback) => {
        const helpers = {
          appendChange: jest.fn().mockResolvedValue(BigInt(1)),
          publishOutbox: jest.fn().mockResolvedValue(undefined),
          recordTombstone: jest.fn().mockResolvedValue(undefined),
        };
        return callback({} as any, helpers as any);
      }),
    } as unknown as jest.Mocked<TransactionService>;

    tagsService = {
      invalidateTagsCache: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TagsService>;

    typesService = {
      isValidItemType: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<TypesService>;

    transformer = new ItemTransformer(typesService as any);

    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RedisCacheService>;

    service = new ItemsService(
      queryRepo,
      commandRepo,
      txService,
      tagsService,
      typesService,
      transformer,
      undefined,
      undefined,
      undefined,
      cache,
    );
  });

  describe('getItem (Cache-Aside Pattern)', () => {
    it('should query DB on cache miss, populate cache, and return mapped item', async () => {
      cache.get.mockResolvedValueOnce(null);

      const result = await service.getItem(mockUserId, mockItemId);

      expect(cache.get).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
      expect(queryRepo.findById).toHaveBeenCalledWith(mockUserId, mockItemId, undefined);
      expect(cache.set).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.item(mockItemId),
        expect.objectContaining({ id: mockItemId, title: 'Attention Is All You Need' }),
        300,
      );
      expect(result).toBeDefined();
      expect(result?.title).toBe('Attention Is All You Need');
    });

    it('should serve directly from cache on hit without querying database', async () => {
      const cachedItem = {
        id: mockItemId,
        userId: mockUserId,
        title: 'Attention Is All You Need (Cached)',
        itemType: 'journalArticle',
      };
      cache.get.mockResolvedValueOnce(cachedItem);

      const result = await service.getItem(mockUserId, mockItemId);

      expect(cache.get).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
      expect(queryRepo.findById).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
      expect(result).toEqual(cachedItem);
    });

    it('should fall back to DB lookup if cached item belongs to different unauthorized tenant', async () => {
      const cachedOtherUserItem = {
        id: mockItemId,
        userId: 'other-user-9999',
        projectId: null,
        title: 'Secret Paper',
      };
      cache.get.mockResolvedValueOnce(cachedOtherUserItem);

      const result = await service.getItem(mockUserId, mockItemId);

      // Should bypass mismatched cached item and verify database access
      expect(queryRepo.findById).toHaveBeenCalledWith(mockUserId, mockItemId, undefined);
      expect(result).toBeDefined();
    });
  });

  describe('getFulltext (Cache-Aside Pattern for Structured Full-Text)', () => {
    it('should query DB and metadata record on cache miss, then cache for 600s', async () => {
      cache.get.mockResolvedValueOnce(null);

      const result = await service.getFulltext(mockUserId, mockItemId);

      expect(cache.get).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemFulltext(mockItemId));
      expect(queryRepo.findMetadataSourceRecord).toHaveBeenCalledWith(mockItemId, 'grobid_fulltext');
      expect(cache.set).toHaveBeenCalledWith(
        LIBRARY_REDIS_KEYS.itemFulltext(mockItemId),
        expect.objectContaining({ title: 'Attention Is All You Need', sections: expect.any(Array) }),
        600,
      );
      expect(result.sections).toHaveLength(1);
    });

    it('should return cached fulltext instantly on cache hit without re-reading metadata', async () => {
      const cachedFulltext = {
        title: 'Attention Is All You Need',
        abstract: 'Cached abstract...',
        sections: [{ title: 'Intro', text: '...' }],
        figures: [],
        tables: [],
        formulas: [],
        references: [],
      };
      cache.get.mockResolvedValueOnce(cachedFulltext);

      const result = await service.getFulltext(mockUserId, mockItemId);

      expect(cache.get).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemFulltext(mockItemId));
      expect(queryRepo.findById).not.toHaveBeenCalled();
      expect(queryRepo.findMetadataSourceRecord).not.toHaveBeenCalled();
      expect(result).toEqual(cachedFulltext);
    });
  });

  describe('listItems (Cache-Aside for Paginated Lists)', () => {
    it('should cache clean list query result for 60s', async () => {
      cache.get.mockResolvedValueOnce(null);

      const result = await service.listItems(mockUserId, { view: 'all', limit: 20 });

      expect(cache.get).toHaveBeenCalled();
      expect(queryRepo.findMany).toHaveBeenCalled();
      expect(cache.set).toHaveBeenCalledWith(
        expect.stringContaining(`library:${mockUserId}:items:list`),
        expect.objectContaining({ items: expect.any(Array) }),
        60,
      );
      expect(result.items).toHaveLength(1);
    });

    it('should bypass cache when search query or cursor is present', async () => {
      await service.listItems(mockUserId, { search: 'quantum', limit: 20 });
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  describe('Mutation Invalidation (Cache Purging)', () => {
    it('should invalidate item and list caches on updateItem', async () => {
      await service.updateItem(mockUserId, mockItemId, 1, { title: 'Updated Title' });

      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemDetails(mockItemId));
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemFulltext(mockItemId));
      expect(cache.delPattern).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemsPattern(mockUserId));
    });

    it('should invalidate item and list caches on deleteItem', async () => {
      await service.deleteItem(mockUserId, mockItemId, 1);

      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemDetails(mockItemId));
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemFulltext(mockItemId));
      expect(cache.delPattern).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemsPattern(mockUserId));
    });

    it('should invalidate item and list caches on restoreItem', async () => {
      await service.restoreItem(mockUserId, mockItemId, 2);

      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemDetails(mockItemId));
      expect(cache.delPattern).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemsPattern(mockUserId));
    });

    it('should invalidate item and list caches on purgeItem', async () => {
      await service.purgeItem(mockUserId, mockItemId);

      expect(cache.del).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.item(mockItemId));
      expect(cache.delPattern).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemsPattern(mockUserId));
    });

    it('should invalidate list cache on createItem', async () => {
      await service.createItem(mockUserId, {
        title: 'New Paper',
        itemType: 'journalArticle',
        uploadedById: mockUserId,
      } as any);

      expect(cache.delPattern).toHaveBeenCalledWith(LIBRARY_REDIS_KEYS.itemsPattern(mockUserId));
    });
  });

  describe('Resilience & Graceful Degradation', () => {
    it('should function smoothly without cache if RedisCacheService is not provided', async () => {
      const bareService = new ItemsService(
        queryRepo,
        commandRepo,
        txService,
        tagsService,
        typesService,
        transformer,
      );

      const item = await bareService.getItem(mockUserId, mockItemId);
      expect(item?.title).toBe('Attention Is All You Need');

      const fulltext = await bareService.getFulltext(mockUserId, mockItemId);
      expect(fulltext.sections).toHaveLength(1);
    });

    it('should continue executing without throwing if cache.get throws an error', async () => {
      cache.get.mockRejectedValueOnce(new Error('Redis Connection Failure'));

      const item = await service.getItem(mockUserId, mockItemId);
      expect(item).toBeDefined();
      expect(queryRepo.findById).toHaveBeenCalled();
    });
  });
});
