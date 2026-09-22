import { SearchService } from '../../src/modules/library/search/application/services/search.service';
import { SearchFacade } from '../../src/modules/library/search/search.facade';
import { SearchRepository } from '../../src/modules/library/search/infrastructure/repositories/search.repository';
import { FullTextProvider } from '../../src/modules/library/search/infrastructure/providers/full-text.provider';

describe('Library Search Module Architecture & Isolation', () => {
  let searchService: SearchService;
  let searchFacade: SearchFacade;
  let mockSearchRepo: jest.Mocked<Partial<SearchRepository>>;
  let mockFullTextProvider: jest.Mocked<Partial<FullTextProvider>>;

  beforeEach(() => {
    mockSearchRepo = {
      searchItems: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'item-1',
            title: 'Quantum Computing and Information Retrieval',
            year: 2024,
            doi: '10.1000/182',
            itemType: 'journalArticle',
            publicationTitle: 'Journal of Computing',
            abstract: 'Comprehensive survey on quantum search algorithms.',
            citationKey: 'Quantum2024',
            userId: 'user-1',
            projectId: null,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            contributors: [{ id: 'c-1', fullName: 'Alice Smith', role: 'author' }],
            attachments: [],
            tags: [],
          },
        ],
        nextCursor: null,
        hasNextPage: false,
      }),
      computeFacets: jest.fn().mockResolvedValue({
        itemTypes: { journalArticle: 1 },
        years: { '2024': 1 },
        tags: {},
        collections: {},
      }),
      findAttachmentWithItem: jest.fn().mockResolvedValue({
        id: 'att-1',
        item: { id: 'item-1', userId: 'user-1', projectId: null },
      } as any),
    };

    mockFullTextProvider = {
      searchPageAnchors: jest.fn().mockResolvedValue([
        {
          attachmentId: 'att-1',
          pageIndex: 1,
          snippet: '...overview of quantum search algorithms...',
          charOffsetStart: 120,
          charOffsetEnd: 127,
        },
      ]),
      indexAttachmentPages: jest.fn().mockResolvedValue(undefined),
    };

    searchService = new SearchService(
      mockSearchRepo as unknown as SearchRepository,
      mockFullTextProvider as unknown as FullTextProvider,
    );

    searchFacade = new SearchFacade(searchService);
  });

  describe('SearchService Core Facets & FTS', () => {
    it('should perform faceted search with cursor pagination cleanly without AI coupling', async () => {
      const result = await searchService.search('user-1', {
        query: 'quantum',
        limit: 10,
      });

      expect(mockSearchRepo.searchItems).toHaveBeenCalledWith('user-1', {
        q: 'quantum',
        collectionId: undefined,
        tagId: undefined,
        limit: 10,
        cursor: undefined,
        projectId: undefined,
      });

      expect(mockSearchRepo.computeFacets).toHaveBeenCalledWith('user-1', {
        q: 'quantum',
        collectionId: undefined,
        tagId: undefined,
        limit: 10,
        cursor: undefined,
        projectId: undefined,
      });

      expect(result.items).toHaveLength(1);
      expect(result.facets.itemTypes.journalArticle).toBe(1);
      expect(result.meta.pageCount).toBe(1);
      expect(result.meta.hasNextPage).toBe(false);
    });

    it('should search page anchors for PDF attachments', async () => {
      const anchors = await searchService.searchPageAnchors(
        'user-1',
        'att-1',
        'quantum',
        1,
      );

      expect(mockSearchRepo.findAttachmentWithItem).toHaveBeenCalledWith('att-1');
      expect(mockFullTextProvider.searchPageAnchors).toHaveBeenCalledWith(
        'att-1',
        'quantum',
        1,
      );
      expect(anchors).toHaveLength(1);
      expect(anchors[0].pageIndex).toBe(1);
      expect(anchors[0].snippet).toContain('quantum');
    });

    it('should rebuild local search index cleanly', async () => {
      const stats = await searchService.rebuildIndex('user-1');

      expect(mockSearchRepo.computeFacets).toHaveBeenCalledWith('user-1', {});
      expect(stats.indexedItems).toBe(1);
      expect(stats.indexedAttachments).toBe(0);
    });
  });

  describe('SearchFacade Bounded Context Boundary', () => {
    it('should delegate search to SearchService', async () => {
      const result = await searchFacade.search('user-1', { query: 'quantum' });
      expect(result.items).toHaveLength(1);
    });

    it('should handle reindexItem cleanly and return localIndexed: true', async () => {
      const res = await searchFacade.reindexItem({ id: 'item-1' });
      expect(res).toEqual({ localIndexed: true });
    });

    it('should no-op on indexItem without throwing or calling external APIs', async () => {
      await expect(searchFacade.indexItem({ id: 'item-1' })).resolves.toBeUndefined();
    });
  });
});
