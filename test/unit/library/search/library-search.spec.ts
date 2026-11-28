import { NotFoundException } from '@nestjs/common';
import {
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
import {
  SearchService,
  SearchEventsSubscriber,
} from '@/modules/library/search/services/search.service';
import { ConditionEvaluatorEngine } from '@/modules/library/catalog/domain/condition-evaluator.policy';
import { SavedSearchesService } from '@/modules/library/catalog/services/saved-searches.service';
import { SavedSearchesRepository } from '@/modules/library/catalog/repositories/saved-searches.repository';
import { SavedSearchConditionGroup } from '@/modules/library/catalog/types/catalog.types';
import { PrismaService, RedisCacheService } from '@/core';

describe('Library Search — Specifications, Facets, Events & Saved Searches', () => {
  const mockUserId = 'user-uuid-111';
  const mockProjectId = 'proj-uuid-222';

  describe('Specification Pattern & SearchRepository Facet Pushdown', () => {
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

    it('evaluates and composes Scope, ActiveItems, ItemType, YearRange, Collection, Tag, and TextSearch specifications', () => {
      expect(new ScopeSpecification('user-1').isSatisfiedBy(sampleItem)).toBe(
        true,
      );
      expect(
        new ScopeSpecification('user-1', 'proj-1').toPrismaWhere(),
      ).toEqual({ spaceId: 'proj-1' });

      expect(new ActiveItemsSpecification().isSatisfiedBy(sampleItem)).toBe(
        true,
      );
      expect(
        new ActiveItemsSpecification().isSatisfiedBy({
          ...sampleItem,
          deletedAt: new Date(),
        }),
      ).toBe(false);

      expect(
        new YearRangeSpecification(2020, 2025).isSatisfiedBy(sampleItem),
      ).toBe(true);
      expect(
        new CollectionSpecification(['col-1', 'col-2']).isSatisfiedBy(
          sampleItem,
        ),
      ).toBe(true);
      expect(new TagSpecification('tag-ai').isSatisfiedBy(sampleItem)).toBe(
        true,
      );
      expect(
        new TextSearchSpecification('multi-head').isSatisfiedBy(sampleItem),
      ).toBe(true);
      expect(
        new TextSearchSpecification('quantum').isSatisfiedBy(sampleItem),
      ).toBe(false);

      const composed = new ActiveItemsSpecification().and(
        new ItemTypeSpecification('journalArticle'),
      );
      expect(composed.toPrismaWhere()).toEqual({
        AND: [{ deletedAt: null }, { itemType: 'journalArticle' }],
      });

      const built = SearchSpecificationBuilder.fromOptions('user-1', {
        collectionId: 'col-1',
        tagId: 'tag-ai',
        yearFrom: 2020,
        yearTo: 2025,
        q: 'transformer',
      });
      expect(built.isSatisfiedBy(sampleItem)).toBe(true);
      expect(built.isSatisfiedBy({ ...sampleItem, year: 2018 })).toBe(false);
    });

    it('builds deep ILIKE clauses, serves cached facets, pushes down PostgreSQL groupBy on miss, and handles search events', async () => {
      const itemMock = {
        findMany: jest.fn(),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([
            { itemType: 'journalArticle', _count: { _all: 25 } },
            { itemType: 'book', _count: { _all: 5 } },
          ])
          .mockResolvedValueOnce([
            { year: 2024, _count: { _all: 20 } },
            { year: 2023, _count: { _all: 10 } },
          ]),
      };
      const itemTagMock = {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { tag: { name: 'NLP' } },
            { tag: { name: 'NLP' } },
            { tag: { name: 'LLM' } },
          ]),
      };
      const mockCache = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        delPattern: jest.fn().mockResolvedValue(undefined),
      };

      const searchRepo = new SearchRepository(
        {
          item: itemMock,
          libraryItem: itemMock,
          itemTag: itemTagMock,
          libraryItemTag: itemTagMock,
        } as unknown as PrismaService,
        mockCache as unknown as RedisCacheService,
      );

      const ilikeWhere = (
        searchRepo as unknown as {
          buildTextWhereIlike: (q: string) => { OR: Array<Record<string, unknown>> };
        }
      ).buildTextWhereIlike('self-attention');
      expect(JSON.stringify(ilikeWhere.OR)).toContain('notesList');
      expect(JSON.stringify(ilikeWhere.OR)).toContain('annotations');

      const computed = await searchRepo.computeFacets('user-1', {});
      expect(computed).toEqual({
        itemTypes: { journalArticle: 25, book: 5 },
        years: { 2024: 20, 2023: 10 },
        tags: { NLP: 2, LLM: 1 },
      });
      expect(mockCache.set).toHaveBeenCalled();

      mockCache.get.mockImplementation(async (k: string) =>
        k.includes('library:search:version:') ? '1' : computed,
      );
      itemMock.groupBy.mockClear();
      expect(await searchRepo.computeFacets('user-1', {})).toEqual(computed);
      expect(itemMock.groupBy).not.toHaveBeenCalled();

      const deleteFts = jest.fn().mockResolvedValue(undefined);
      const invalidateFacets = jest.fn().mockResolvedValue(undefined);
      const mockRepoForEvents = {
        invalidateFacets,
        deleteFullTextIndexByItemId: deleteFts,
        searchItems: jest.fn().mockResolvedValue({
          items: [{ id: 'item-p2' }],
          nextCursor: 'item-p2',
          hasNextPage: false,
        }),
        computeFacets: jest.fn(),
      } as unknown as SearchRepository;

      const svc = new SearchService(mockRepoForEvents, {} as never);
      const subscriber = new SearchEventsSubscriber(svc, mockRepoForEvents);

      await subscriber.handleItemChanged({
        eventId: 'evt-1',
        eventType: 'library.item.created',
        aggregateId: 'item-100',
        userId: 'user-1',
        projectId: 'proj-1',
        spaceId: 'proj-1',
        createdAt: new Date(),
        schemaVersion: 1,
        payload: { itemId: 'item-100' },
      });
      expect(invalidateFacets).toHaveBeenCalledWith('proj-1');

      await subscriber.handleItemDeleted({
        eventId: 'evt-2',
        eventType: 'library.item.deleted',
        aggregateId: 'item-100',
        userId: 'user-1',
        spaceId: 'user-1',
        createdAt: new Date(),
        schemaVersion: 1,
        payload: { itemId: 'item-100' },
      });
      expect(deleteFts).not.toHaveBeenCalled();

      await subscriber.handleItemPurged({
        eventId: 'evt-3',
        eventType: 'library.item.purged',
        aggregateId: 'item-100',
        userId: 'user-1',
        spaceId: 'user-1',
        createdAt: new Date(),
        schemaVersion: 1,
        payload: { itemId: 'item-100' },
      });
      expect(deleteFts).toHaveBeenCalledWith('item-100');

      const cursorRes = await svc.search('user-1', {
        query: 'transformer',
        cursor: 'item-p1',
        includeFacets: false,
      });
      expect(mockRepoForEvents.computeFacets).not.toHaveBeenCalled();
      expect(cursorRes.items).toHaveLength(1);
    });
  });

  describe('ConditionEvaluatorEngine & SavedSearchesService', () => {
    const engine = new ConditionEvaluatorEngine();

    it('compiles multi-tenant scopes, subcollection expansion, and operators across title, creator, year, itemType, tag, readStatus, rating, dateAdded, attachmentContent, and noteContent', () => {
      expect(
        engine.compile(mockUserId, { conjunction: 'AND', conditions: [] }),
      ).toEqual({ spaceId: mockUserId, deletedAt: null });
      expect(
        engine.compile(
          mockUserId,
          { conjunction: 'AND', conditions: [] },
          mockProjectId,
        ),
      ).toEqual({ spaceId: mockProjectId, deletedAt: null });

      const descendantMap = new Map<string, string[]>([
        ['col-ml', ['col-nlp', 'col-cv']],
      ]);
      const complexGroup: SavedSearchConditionGroup = {
        conjunction: 'AND',
        scopeOptions: { showOnlyTopLevel: true, searchSubcollections: true },
        conditions: [
          { field: 'title', operator: 'beginsWith', value: 'Intro' },
          { field: 'creator', operator: 'doesNotContain', value: 'Newton' },
          { field: 'year', operator: 'isBetween', value: [2018, 2023] },
          { field: 'year', operator: 'is', value: 'not-a-number' },
          { field: 'itemType', operator: 'isNot', value: 'book' },
          { field: 'tag', operator: 'beginsWith', value: 'AI/' },
          { field: 'collection', operator: 'is', value: 'col-ml' },
          { field: 'readStatus', operator: 'is', value: 'unread' },
          { field: 'rating', operator: 'isAbsent' },
          { field: 'dateAdded', operator: 'isInTheLast', value: '7 days' },
          {
            field: 'attachmentContent',
            operator: 'contains',
            value: 'transformer',
          },
          { field: 'noteContent', operator: 'contains', value: 'hypothesis' },
          { field: 'url', operator: 'contains', value: 'arxiv.org' },
        ],
      };

      expect(engine.extractReferencedCollectionIds(complexGroup)).toEqual([
        'col-ml',
      ]);
      const compiledJson = JSON.stringify(
        engine.compile(mockUserId, complexGroup, undefined, descendantMap),
      );
      expect(compiledJson).toContain('col-nlp');
      expect(compiledJson).toContain('col-cv');
      expect(compiledJson).toContain('fullTextIndexes');
      expect(compiledJson).toContain('notesList');
      expect(compiledJson).not.toContain('not-a-number');
    });

    it('manages personal and project saved searches, previews, execution cachedCount updates, and single-flight findAll', async () => {
      const mockRepo = {
        create: jest
          .fn()
          .mockImplementation(
            async (_u: string, dto: { name: string }, proj?: string | null) => ({
              id: 'search-1',
              userId: mockUserId,
              projectId: proj ?? null,
              name: dto.name,
              cachedCount: 0,
            }),
          ),
        findById: jest.fn(),
        findAll: jest.fn(
          () =>
            new Promise<Array<{ id: string; cachedCount: number }>>((r) =>
              setTimeout(() => r([{ id: 's1', cachedCount: 3 }]), 1),
            ),
        ),
        updateCachedCount: jest.fn().mockResolvedValue({}),
        countMatchingItems: jest.fn().mockResolvedValue(5),
        findMatchingItems: jest.fn().mockResolvedValue({
          items: [{ id: 'item-1', title: 'Paper 1' }],
          nextCursor: undefined,
          hasNextPage: false,
        }),
      };

      const service = new SavedSearchesService(
        mockRepo as unknown as SavedSearchesRepository,
        engine,
      );

      const created = await service.create(
        mockUserId,
        {
          name: 'Project Smart Collection',
          conditions: {
            conjunction: 'AND',
            conditions: [{ field: 'tag', operator: 'is', value: 'AI' }],
          },
        },
        mockProjectId,
      );
      expect(created.cachedCount).toBe(5);

      mockRepo.findById.mockResolvedValueOnce(null);
      await expect(service.findById(mockUserId, 'missing')).rejects.toThrow(
        NotFoundException,
      );

      const preview = await service.preview(
        mockUserId,
        {
          conditions: {
            conjunction: 'AND',
            conditions: [
              { field: 'hasAttachment', operator: 'is', value: true },
            ],
          },
        },
        mockProjectId,
      );
      expect(preview).toMatchObject({ count: 5 });
      expect(preview.sampleItems).toHaveLength(1);

      mockRepo.findById.mockResolvedValueOnce({
        id: 'search-exec',
        userId: mockUserId,
        projectId: mockProjectId,
        name: 'Review',
        conditions: {
          conjunction: 'AND',
          conditions: [{ field: 'readStatus', operator: 'is', value: 'unread' }],
        },
      });
      const executed = await service.execute(
        mockUserId,
        'search-exec',
        { limit: 20 },
        mockProjectId,
      );
      expect(executed.meta.totalCount).toBe(5);
      expect(mockRepo.updateCachedCount).toHaveBeenCalledWith('search-exec', 5);

      await Promise.all(
        Array.from({ length: 20 }, () =>
          service.findAll(mockUserId, mockProjectId),
        ),
      );
      expect(mockRepo.findAll).toHaveBeenCalledTimes(1);
    });
  });
});
