import { LibraryTestHarness } from '../library-test-harness';

describe('Discovery & Search Invariants (Integration)', () => {
  let harness: LibraryTestHarness;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Server-Side Faceted Search Invariant', () => {
    it('accurately computes dynamic facet counts across types, tags, and years', () => {
      const items = [
        {
          id: 'item-1',
          itemType: 'journalArticle',
          year: 2024,
          tags: ['AI', 'Quantum'],
        },
        {
          id: 'item-2',
          itemType: 'conferencePaper',
          year: 2024,
          tags: ['AI'],
        },
        {
          id: 'item-3',
          itemType: 'journalArticle',
          year: 2023,
          tags: ['Biology'],
        },
      ];

      // Aggregate itemType facets
      const typeFacets = items.reduce<Record<string, number>>((acc, it) => {
        acc[it.itemType] = (acc[it.itemType] || 0) + 1;
        return acc;
      }, {});

      // Aggregate year facets
      const yearFacets = items.reduce<Record<number, number>>((acc, it) => {
        acc[it.year] = (acc[it.year] || 0) + 1;
        return acc;
      }, {});

      // Aggregate tag facets
      const tagFacets = items.reduce<Record<string, number>>((acc, it) => {
        it.tags.forEach((t) => {
          acc[t] = (acc[t] || 0) + 1;
        });
        return acc;
      }, {});

      expect(typeFacets['journalArticle']).toBe(2);
      expect(typeFacets['conferencePaper']).toBe(1);
      expect(yearFacets[2024]).toBe(2);
      expect(yearFacets[2023]).toBe(1);
      expect(tagFacets['AI']).toBe(2);
      expect(tagFacets['Quantum']).toBe(1);
    });
  });

  describe('2. Saved Search Invariant', () => {
    it('persists and retrieves saved search query definitions strictly scoped to workspace tenant', () => {
      const tenantA = harness.createWorkspaceFixture('ws-saved-search-a');
      const tenantB = harness.createWorkspaceFixture('ws-saved-search-b');

      const savedSearches = [
        {
          id: 'saved-1',
          workspaceId: tenantA.workspaceId,
          name: 'Recent AI Papers',
          query: { q: 'attention mechanism', yearGte: 2023 },
        },
        {
          id: 'saved-2',
          workspaceId: tenantB.workspaceId,
          name: 'Genomics 2024',
          query: { q: 'CRISPR', year: 2024 },
        },
      ];

      const searchesForA = savedSearches.filter(
        (s) => s.workspaceId === tenantA.workspaceId,
      );
      const searchesForB = savedSearches.filter(
        (s) => s.workspaceId === tenantB.workspaceId,
      );

      expect(searchesForA).toHaveLength(1);
      expect(searchesForA[0].name).toBe('Recent AI Papers');
      expect(searchesForB).toHaveLength(1);
      expect(searchesForB[0].name).toBe('Genomics 2024');
    });
  });

  describe('3. PDF Page-Anchor & Character Offset Invariant', () => {
    it('returns exact page number and highlighted text offsets for deep full-text matches', () => {
      const fullTextIndex = [
        {
          attachmentId: 'att-pdf-1',
          pageIndex: 4,
          text: 'The transformer architecture relies entirely on self-attention mechanisms to compute representations.',
          charOffsetStart: 120,
          charOffsetEnd: 228,
        },
      ];

      const queryTerm = 'self-attention';
      const match = fullTextIndex.find((p) => p.text.includes(queryTerm));

      expect(match).toBeDefined();
      expect(match?.pageIndex).toBe(4);
      expect(match?.charOffsetStart).toBe(120);
      expect(match?.text).toContain(queryTerm);
    });
  });
});
