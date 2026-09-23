import {
  CompositeSpecification,
  ScopeSpecification,
  ActiveItemsSpecification,
  ItemTypeSpecification,
  YearRangeSpecification,
  CollectionSpecification,
  TagSpecification,
  TextSearchSpecification,
} from '../../src/modules/library/search/domain/specifications/item-specifications';
import { SearchSpecificationBuilder } from '../../src/modules/library/search/domain/specifications/search-specification.builder';
import { SearchRepository } from '../../src/modules/library/search/infrastructure/repositories/search.repository';
import { SearchService } from '../../src/modules/library/search/application/services/search.service';
import { CatalogEventsSubscriber } from '../../src/modules/library/search/infrastructure/subscribers/catalog-events.subscriber';
import { PrismaService } from '../../src/core/database/prisma.service';
import { RedisCacheService } from '../../src/core/cache/redis.service';

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
      notesList: [{ title: 'Notes on Transformers', contentMd: 'Self-attention mechanism details' }],
      attachments: [
        {
          annotations: [{ quoteText: 'Multi-head attention', comment: 'Key breakthrough' }],
        },
      ],
    };

    it('should evaluate ScopeSpecification for personal and project libraries', () => {
      const personalSpec = new ScopeSpecification('user-1');
      expect(personalSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(personalSpec.isSatisfiedBy({ ...sampleItem, userId: 'other-user' })).toBe(false);

      expect(personalSpec.toPrismaWhere()).toEqual({
        userId: 'user-1',
      });

      const projectSpec = new ScopeSpecification('user-1', 'proj-1');
      expect(projectSpec.isSatisfiedBy({ ...sampleItem, projectId: 'proj-1' })).toBe(true);
      expect(projectSpec.toPrismaWhere()).toEqual({
        projectId: 'proj-1',
      });
    });

    it('should evaluate ActiveItemsSpecification (soft-delete filter)', () => {
      const activeSpec = new ActiveItemsSpecification();
      expect(activeSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(activeSpec.isSatisfiedBy({ ...sampleItem, deletedAt: new Date() })).toBe(false);
      expect(activeSpec.toPrismaWhere()).toEqual({ deletedAt: null });
    });

    it('should evaluate ItemTypeSpecification', () => {
      const typeSpec = new ItemTypeSpecification('journalArticle');
      expect(typeSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(typeSpec.isSatisfiedBy({ ...sampleItem, itemType: 'book' })).toBe(false);
      expect(typeSpec.toPrismaWhere()).toEqual({ itemType: 'journalArticle' });
    });

    it('should evaluate YearRangeSpecification for bounded and open intervals', () => {
      const rangeSpec = new YearRangeSpecification(2020, 2025);
      expect(rangeSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(rangeSpec.isSatisfiedBy({ ...sampleItem, year: 2019 })).toBe(false);
      expect(rangeSpec.toPrismaWhere()).toEqual({
        year: { gte: 2020, lte: 2025 },
      });

      const minOnlySpec = new YearRangeSpecification(2020);
      expect(minOnlySpec.isSatisfiedBy({ ...sampleItem, year: 2021 })).toBe(true);
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
      expect(colSpec.isSatisfiedBy({ ...sampleItem, collectionItems: [] })).toBe(false);
      expect(colSpec.toPrismaWhere()).toEqual({
        collectionItems: { some: { collectionId: 'col-1' } },
      });

      const tagSpec = new TagSpecification('tag-ai');
      expect(tagSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(tagSpec.isSatisfiedBy({ ...sampleItem, itemTags: [] })).toBe(false);
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

    it('should compose specifications using .and(), .or(), and .not()', () => {
      const activeSpec = new ActiveItemsSpecification();
      const typeSpec = new ItemTypeSpecification('journalArticle');
      const bookSpec = new ItemTypeSpecification('book');

      // AND composition
      const activeArticleSpec = activeSpec.and(typeSpec);
      expect(activeArticleSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(activeArticleSpec.isSatisfiedBy({ ...sampleItem, deletedAt: new Date() })).toBe(false);
      expect(activeArticleSpec.toPrismaWhere()).toEqual({
        AND: [{ deletedAt: null }, { itemType: 'journalArticle' }],
      });

      // OR composition
      const articleOrBookSpec = typeSpec.or(bookSpec);
      expect(articleOrBookSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(articleOrBookSpec.isSatisfiedBy({ ...sampleItem, itemType: 'book' })).toBe(true);
      expect(articleOrBookSpec.isSatisfiedBy({ ...sampleItem, itemType: 'webpage' })).toBe(false);
      expect(articleOrBookSpec.toPrismaWhere()).toEqual({
        OR: [{ itemType: 'journalArticle' }, { itemType: 'book' }],
      });

      // NOT composition
      const notBookSpec = bookSpec.not();
      expect(notBookSpec.isSatisfiedBy(sampleItem)).toBe(true);
      expect(notBookSpec.isSatisfiedBy({ ...sampleItem, itemType: 'book' })).toBe(false);
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

      const facets = await searchRepo.computeFacets('user-1', { collectionId: 'col-1' });

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

    it('should gracefully degrade to findMany scan fallback if groupBy fails', async () => {
      (mockCache.get as jest.Mock).mockResolvedValue(null);
      (mockPrisma.item.groupBy as jest.Mock).mockRejectedValueOnce(
        new Error('groupBy not supported on mocked client'),
      );

      (mockPrisma.item.findMany as jest.Mock).mockResolvedValueOnce([
        {
          itemType: 'journalArticle',
          year: 2024,
          itemTags: [{ tag: { name: 'Robotics' } }],
        },
      ]);

      const facets = await searchRepo.computeFacets('user-1', {});

      expect(facets).toEqual({
        itemTypes: { journalArticle: 1 },
        years: { 2024: 1 },
        tags: { Robotics: 1 },
      });
      expect(mockPrisma.item.findMany).toHaveBeenCalled();
    });

    it('should invalidate facet cache by scope pattern', async () => {
      await searchRepo.invalidateFacets('user-1');

      expect(mockCache.delPattern).toHaveBeenCalledWith(
        'library:search:facets:*user-1*',
      );
    });
  });

  describe('3. Event-Driven Facet Invalidation (CatalogEventsSubscriber & SearchService)', () => {
    let searchService: Partial<SearchService>;
    let searchRepo: Partial<SearchRepository>;
    let subscriber: CatalogEventsSubscriber;

    beforeEach(() => {
      searchRepo = {
        invalidateFacets: jest.fn().mockResolvedValue(undefined),
      };
      searchService = new SearchService(searchRepo as any, {} as any);
      subscriber = new CatalogEventsSubscriber(searchService as any);
    });

    it('should delegate facet invalidation from SearchService to SearchRepository', async () => {
      await searchService.invalidateFacetsCache!('user-1');
      expect(searchRepo.invalidateFacets).toHaveBeenCalledWith('user-1');
    });

    it('should invalidate facet cache when CATALOG_ITEM_CREATED integration event arrives', async () => {
      const invalidateSpy = jest.spyOn(searchService, 'invalidateFacetsCache');

      await subscriber.handleItemCreated({
        eventId: 'evt-1',
        topic: 'library.integration.catalog.item_created',
        occurredAt: new Date().toISOString(),
        sourceContext: 'catalog',
        scope: {
          userId: 'user-1',
          projectId: 'proj-1',
        },
        payload: {
          itemId: 'item-100',
          title: 'New Paper',
          itemType: 'journalArticle',
        } as any,
      });

      expect(invalidateSpy).toHaveBeenCalledWith('proj-1');
      expect(searchRepo.invalidateFacets).toHaveBeenCalledWith('proj-1');
    });

    it('should invalidate facet cache when CATALOG_ITEM_DELETED integration event arrives', async () => {
      const invalidateSpy = jest.spyOn(searchService, 'invalidateFacetsCache');

      await subscriber.handleItemDeleted({
        eventId: 'evt-2',
        topic: 'library.integration.catalog.item_deleted',
        occurredAt: new Date().toISOString(),
        sourceContext: 'catalog',
        scope: {
          userId: 'user-1',
          projectId: null,
        },
        payload: {
          itemId: 'item-100',
        } as any,
      });

      expect(invalidateSpy).toHaveBeenCalledWith('user-1');
      expect(searchRepo.invalidateFacets).toHaveBeenCalledWith('user-1');
    });
  });
});
