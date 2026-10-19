import {
  CompositeSpecification,
  ScopeSpecification,
  ActiveItemsSpecification,
  ItemTypeSpecification,
  YearRangeSpecification,
  CollectionSpecification,
  TagSpecification,
  TextSearchSpecification,
  SearchSpecificationBuilder,
} from '@/modules/library/search';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { SearchService } from '@/modules/library/search/services/search.service';
import { SearchEventsSubscriber } from '@/modules/library/search/subscribers/search-events.subscriber';
import { PrismaService } from '@/core';
import { RedisCacheService } from '@/core';

describe('Pattern 3: Specification Pattern & Materialized Facet Projections for Faceted Search', () => {
  describe('1. Specification Pattern & Composability', () => {
    const sampleItem = {
      id: 'item-1',
      userId: 'user-1',
      projectId: null,
      deletedAt: null,
      itemType: 'journalArticle',
      year: 2024,
      title: 'Attention is All You Need for Deep Learning',
      abstract: 'A transformer-based neural network architecture.',
      doi: '10.1000/182',
      citationKey: 'vaswani2017attention',
      collectionItems: [{ collectionId: 'col-1' }],
      itemTags: [{ tagId: 'tag-ai', tag: { name: 'Machine Learning' } }],
      notesList: [
        {
          title: 'Notes on Transformers',
          contentMd: 'Self-attention mechanism details',
        },
      ],
      attachments: [
        {
          annotations: [
            { quoteText: 'Multi-head attention', comment: 'Key breakthrough' },
          ],
        },
      ],
    };

    it('should evaluate ScopeSpecification for user and project libraries', () => {
      const userSpec = new ScopeSpecification('user-1');
      expect(userSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(
        userSpec.isSatisfiedBy({ ...sampleItem, userId: 'other-user' }),
      ).toBe(false);

      expect(userSpec.toPrismaWhere()).toEqual({
        userId: 'user-1',
        projectId: null,
      });

      const projectSpec = new ScopeSpecification('user-1', 'proj-1');
      expect(
        projectSpec.isSatisfiedBy({ ...sampleItem, projectId: 'proj-1' }),
      ).toBe(true);
      expect(projectSpec.toPrismaWhere()).toEqual({
        projectId: 'proj-1',
      });
    });

    it('should evaluate ActiveItemsSpecification (soft-delete filter)', () => {
      const activeSpec = new ActiveItemsSpecification();
      expect(activeSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(
        activeSpec.isSatisfiedBy({ ...sampleItem, deletedAt: new Date() }),
      ).toBe(false);
      expect(activeSpec.toPrismaWhere()).toEqual({ deletedAt: null });
    });

    it('should evaluate ItemTypeSpecification', () => {
      const typeSpec = new ItemTypeSpecification('journalArticle');
      expect(typeSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(typeSpec.isSatisfiedBy({ ...sampleItem, itemType: 'book' })).toBe(
        false,
      );
      expect(typeSpec.toPrismaWhere()).toEqual({ itemType: 'journalArticle' });
    });

    it('should evaluate YearRangeSpecification for bounded and open intervals', () => {
      const rangeSpec = new YearRangeSpecification(2020, 2025);
      expect(rangeSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(rangeSpec.isSatisfiedBy({ ...sampleItem, year: 2019 })).toBe(
        false,
      );
      expect(rangeSpec.toPrismaWhere()).toEqual({
        year: { gte: 2020, lte: 2025 },
      });

      const minOnlySpec = new YearRangeSpecification(2020);
      expect(minOnlySpec.isSatisfiedBy({ ...sampleItem, year: 2021 })).toBe(
        true,
      );
      expect(minOnlySpec.toPrismaWhere()).toEqual({
        year: { gte: 2020 },
      });

      const maxOnlySpec = new YearRangeSpecification(undefined, 2023);
      expect(maxOnlySpec.isSatisfiedBy(sampleItem)).toBe(false);
      expect(maxOnlySpec.toPrismaWhere()).toEqual({
        year: { lte: 2023 },
      });
    });

    it('should evaluate CollectionSpecification and TagSpecification', () => {
      const colSpec = new CollectionSpecification('col-1');
      expect(colSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(
        colSpec.isSatisfiedBy({ ...sampleItem, collectionItems: [] }),
      ).toBe(false);
      expect(colSpec.toPrismaWhere()).toEqual({
        collectionItems: { some: { collectionId: 'col-1' } },
      });

      const tagSpec = new TagSpecification('tag-ai');
      expect(tagSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(tagSpec.isSatisfiedBy({ ...sampleItem, itemTags: [] })).toBe(
        false,
      );
      expect(tagSpec.toPrismaWhere()).toEqual({
        itemTags: { some: { tagId: 'tag-ai' } },
      });
    });

    it('should evaluate TextSearchSpecification across title, abstract, notes, and annotations', () => {
      const titleSearch = new TextSearchSpecification('deep learning');
      expect(titleSearch.isSatisfiedBy(sampleItem)).toBe(true);

      const noteSearch = new TextSearchSpecification('mechanism details');
      expect(noteSearch.isSatisfiedBy(sampleItem)).toBe(true);

      const annotationSearch = new TextSearchSpecification('multi-head');
      expect(annotationSearch.isSatisfiedBy(sampleItem)).toBe(true);

      const notFoundSearch = new TextSearchSpecification('quantum computing');
      expect(notFoundSearch.isSatisfiedBy(sampleItem)).toBe(false);

      const prismaWhere = titleSearch.toPrismaWhere();
      expect(prismaWhere.OR).toBeDefined();
      expect(Array.isArray(prismaWhere.OR)).toBe(true);
    });

    it('should compose specifications using .and()', () => {
      const activeSpec = new ActiveItemsSpecification();
      const typeSpec = new ItemTypeSpecification('journalArticle');

      // AND composition
      const activeArticleSpec = activeSpec.and(typeSpec);
      expect(activeArticleSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(
        activeArticleSpec.isSatisfiedBy({
          ...sampleItem,
          deletedAt: new Date(),
        }),
      ).toBe(false);
      expect(activeArticleSpec.toPrismaWhere()).toEqual({
        AND: [{ deletedAt: null }, { itemType: 'journalArticle' }],
      });
    });

    it('should build combined composite specification via SearchSpecificationBuilder', () => {
      const spec = SearchSpecificationBuilder.fromOptions('user-1', {
        collectionId: 'col-1',
        tagId: 'tag-ai',
        yearFrom: 2020,
        yearTo: 2025,
        q: 'transformer',
      });

      expect(spec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(spec.isSatisfiedBy({ ...sampleItem, year: 2018 })).toBe(false);

      const where = spec.toPrismaWhere();
      expect(where.AND).toBeDefined();
      expect(Array.isArray(where.AND)).toBe(true);
    });
  });

  describe('2. Materialized Facet Projections & Cache-Aside (SearchRepository)', () => {
    let searchRepo: SearchRepository;
    let mockPrisma: any;
    let mockCache: Partial<RedisCacheService>;

    beforeEach(() => {
      mockPrisma = {
        item: {
          findMany: jest.fn(),
          groupBy: jest.fn(),
        },
        itemTag: {
          findMany: jest.fn(),
        },
      };

      mockCache = {
        get: jest.fn(),
        set: jest.fn(),
        delPattern: jest.fn(),
      };

      searchRepo = new SearchRepository(
        mockPrisma as PrismaService,
        mockCache as RedisCacheService,
      );
    });

    it('should return cached facet projection when available (Cache Hit)', async () => {
      const cachedFacets = {
        itemTypes: { journalArticle: 42, book: 8 },
        years: { 2023: 30, 2024: 20 },
        tags: { AI: 15 },
      };
      (mockCache.get as jest.Mock).mockResolvedValue(cachedFacets);

      const facets = await searchRepo.computeFacets('user-1', {
        collectionId: 'col-1',
      });

      expect(facets).toEqual(cachedFacets);
      expect(mockCache.get).toHaveBeenCalledTimes(1);
      expect(mockPrisma.item.groupBy).not.toHaveBeenCalled();
      expect(mockPrisma.item.findMany).not.toHaveBeenCalled();
    });

    it('should push down aggregation to PostgreSQL groupBy on cache miss and populate cache with 120s TTL', async () => {
      (mockCache.get as jest.Mock).mockResolvedValue(null);

      (mockPrisma.item.groupBy as jest.Mock)
        .mockResolvedValueOnce([
          { itemType: 'journalArticle', _count: { _all: 25 } },
          { itemType: 'book', _count: { _all: 5 } },
        ])
        .mockResolvedValueOnce([
          { year: 2024, _count: { _all: 20 } },
          { year: 2023, _count: { _all: 10 } },
        ]);

      (mockPrisma.itemTag.findMany as jest.Mock).mockResolvedValueOnce([
        { tag: { name: 'NLP' } },
        { tag: { name: 'NLP' } },
        { tag: { name: 'LLM' } },
      ]);

      const facets = await searchRepo.computeFacets('user-1', {});

      expect(facets).toEqual({
        itemTypes: { journalArticle: 25, book: 5 },
        years: { 2024: 20, 2023: 10 },
        tags: { NLP: 2, LLM: 1 },
      });

      // Verified pushdown database aggregations
      expect(mockPrisma.item.groupBy).toHaveBeenCalledTimes(2);
      expect(mockPrisma.itemTag.findMany).toHaveBeenCalledTimes(1);
      expect(mockCache.set).toHaveBeenCalledWith(
        expect.stringContaining('library:search:facets:user:user-1:'),
        facets,
        120,
      );
    });

    it('should invalidate facet cache by scope pattern', async () => {
      await searchRepo.invalidateFacets('user-1');

      expect(mockCache.delPattern).toHaveBeenCalledWith(
        'library:search:facets:*user-1*',
      );
    });
  });

  describe('3. Event-Driven Facet Invalidation (SearchEventsSubscriber & SearchService)', () => {
    let searchService: Partial<SearchService>;
    let searchRepo: Partial<SearchRepository>;
    let subscriber: SearchEventsSubscriber;

    beforeEach(() => {
      searchRepo = {
        invalidateFacets: jest.fn().mockResolvedValue(undefined),
        deleteFullTextIndexByItemId: jest.fn().mockResolvedValue(undefined),
      };
      searchService = new SearchService(searchRepo as any, {} as any);
      subscriber = new SearchEventsSubscriber(
        searchService as any,
        searchRepo as any,
      );
    });

    it('should delegate facet invalidation from SearchService to SearchRepository', async () => {
      await searchService.invalidateFacetsCache!('user-1');
      expect(searchRepo.invalidateFacets).toHaveBeenCalledWith('user-1');
    });

    it('should invalidate facet cache when ITEM_CREATED domain event arrives', async () => {
      const invalidateSpy = jest.spyOn(searchService, 'invalidateFacetsCache');

      await subscriber.handleItemChanged({
        eventId: 'evt-1',
        eventType: 'library.item.created',
        aggregateId: 'item-100',
        userId: 'user-1',
        projectId: 'proj-1',
        scopeId: 'proj-1',
        createdAt: new Date(),
        schemaVersion: 1,
        payload: {
          itemId: 'item-100',
          title: 'New Paper',
          itemType: 'journalArticle',
        },
      });

      expect(invalidateSpy).toHaveBeenCalledWith('proj-1');
      expect(searchRepo.invalidateFacets).toHaveBeenCalledWith('proj-1');
    });

    it('should clean up FTS index and invalidate facet cache when ITEM_DELETED domain event arrives', async () => {
      const invalidateSpy = jest.spyOn(searchService, 'invalidateFacetsCache');

      await subscriber.handleItemDeletedOrPurged({
        eventId: 'evt-2',
        eventType: 'library.item.deleted',
        aggregateId: 'item-100',
        userId: 'user-1',
        scopeId: 'user-1',
        createdAt: new Date(),
        schemaVersion: 1,
        payload: {
          itemId: 'item-100',
        },
      });

      expect(searchRepo.deleteFullTextIndexByItemId).toHaveBeenCalledWith(
        'item-100',
      );
      expect(invalidateSpy).toHaveBeenCalledWith('user-1');
      expect(searchRepo.invalidateFacets).toHaveBeenCalledWith('user-1');
    });
  });
});
