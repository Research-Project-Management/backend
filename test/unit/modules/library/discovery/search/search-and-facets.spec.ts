import { SearchService as LibrarySearchService } from '@/modules/library/legacy/search/search.service';

describe('Phase 8: Search, Facets & Researcher UX Subsystem', () => {
  let searchService: LibrarySearchService;
  let mockCatalogRepo: any;

  const mockItems = [
    {
      id: 'item-1',
      workspaceId: 'ws-1',
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      year: 2017,
      itemType: 'conferencePaper',
      doi: '10.5555/3295222.3295349',
      abstract:
        'We propose the Transformer model based solely on attention mechanisms.',
      journal: 'NeurIPS',
      volume: '30',
      pages: '5998-6008',
      labels: ['Deep Learning', 'Transformers', 'NLP'],
      readStatus: 'completed',
      createdAt: '2023-01-01T00:00:00.000Z',
    },
    {
      id: 'item-2',
      workspaceId: 'ws-1',
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      authors: ['Devlin, Jacob', 'Chang, Ming-Wei'],
      year: 2018,
      itemType: 'preprint',
      doi: '10.48550/arxiv.1810.04805',
      abstract: 'We introduce a new language representation model called BERT.',
      journal: 'arXiv',
      labels: ['NLP', 'Language Models'],
      readStatus: 'reading',
      createdAt: '2023-02-01T00:00:00.000Z',
    },
    {
      id: 'item-3',
      workspaceId: 'ws-1',
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['He, Kaiming', 'Zhang, Xiangyu'],
      year: 2016,
      itemType: 'conferencePaper',
      doi: '10.1109/CVPR.2016.90',
      abstract: 'Deeper neural networks are more difficult to train.',
      journal: 'CVPR',
      labels: ['Computer Vision', 'Deep Learning'],
      readStatus: 'unread',
      createdAt: '2023-03-01T00:00:00.000Z',
    },
  ];

  beforeEach(() => {
    mockCatalogRepo = {
      resolveWorkspaceId: jest
        .fn()
        .mockImplementation((ws) => Promise.resolve(ws)),
      findItems: jest
        .fn()
        .mockImplementation(() => Promise.resolve([...mockItems])),
    };

    searchService = new LibrarySearchService(mockCatalogRepo, {} as any);
  });

  describe('Full-Text Search & Quality Scoring', () => {
    it('searches items by text query and calculates quality score', async () => {
      const result = await searchService.searchItems('ws-1', {
        q: 'Transformer',
      });

      expect(result.items.length).toBe(2);
      expect(result.pagination.totalItems).toBe(2);

      // Quality score check
      const firstItem = result.items[0];
      expect(firstItem.qualityScore).toBeGreaterThanOrEqual(80); // Title, authors, year, doi, abstract, journal
    });

    it('filters items by facet criteria (itemType, year, tags, readStatus)', async () => {
      const result = await searchService.searchItems('ws-1', {
        itemType: 'conferencePaper',
        yearFrom: 2017,
        tags: ['NLP'],
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0].title).toBe('Attention Is All You Need');
    });

    it('sorts search results by year ascending/descending', async () => {
      const asc = await searchService.searchItems('ws-1', {
        sortBy: 'year',
        sortOrder: 'asc',
      });

      expect(asc.items[0].year).toBe(2016);
      expect(asc.items[2].year).toBe(2018);
    });
  });

  describe('Dynamic Search Facets', () => {
    it('aggregates multi-dimensional facets across the workspace', async () => {
      const facets = await searchService.getSearchFacets('ws-1', {});

      expect(facets.itemTypes).toEqual([
        { value: 'conferencePaper', count: 2 },
        { value: 'preprint', count: 1 },
      ]);

      expect(
        facets.years.some((y: any) => y.value === 2017 && y.count === 1),
      ).toBe(true);
      expect(
        facets.tags.some(
          (t: any) => t.value === 'Deep Learning' && t.count === 2,
        ),
      ).toBe(true);

      expect(facets.readStatuses).toEqual(
        expect.arrayContaining([
          { value: 'completed', count: 1 },
          { value: 'reading', count: 1 },
          { value: 'unread', count: 1 },
        ]),
      );
    });
  });

  describe('Saved Searches', () => {
    it('saves, lists, and deletes a custom search configuration', async () => {
      const saved = await searchService.saveSearch(
        'ws-1',
        'Recent NLP Papers',
        {
          tags: ['NLP'],
          yearFrom: 2017,
        },
      );

      expect(saved.id).toBeDefined();
      expect(saved.name).toBe('Recent NLP Papers');

      const allSaved = await searchService.getSavedSearches('ws-1');
      expect(allSaved.length).toBe(1);
      expect(allSaved[0].id).toBe(saved.id);

      const deleted = await searchService.deleteSavedSearch('ws-1', saved.id);
      expect(deleted).toBe(true);

      const afterDelete = await searchService.getSavedSearches('ws-1');
      expect(afterDelete.length).toBe(0);
    });
  });
});
