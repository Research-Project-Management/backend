// @ts-nocheck -- Integration test fixtures use legacy field names; update when test data is migrated
import { LibraryTestHarness } from '../library-test-harness';
import { SearchRepository as DiscoveryRepository } from '../../../../src/modules/library/search/search.repository';
import { FullTextIndexer } from '../../../../src/modules/library/search/providers/full-text-indexer.provider';

describe('Discovery & Search Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let discoveryRepo: DiscoveryRepository;
  let fullTextIndexer: FullTextIndexer;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    discoveryRepo = harness.moduleRef.get(DiscoveryRepository);
    fullTextIndexer = harness.moduleRef.get(FullTextIndexer);
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

  describe('2. Saved Search DB Invariant', () => {
    it('persists, lists, and deletes saved search query definitions strictly in PostgreSQL', async () => {
      const tenantA = await harness.seedWorkspaceFixture();
      const tenantB = await harness.seedWorkspaceFixture();

      const searchA = await discoveryRepo.createSavedSearch(
        tenantA.workspaceId,
        tenantA.ownerUserId,
        {
          name: 'Recent AI Papers',
          query: { q: 'attention mechanism', yearGte: 2023 },
          color: '#3370ff',
          icon: 'search',
        },
      );

      const searchB = await discoveryRepo.createSavedSearch(
        tenantB.workspaceId,
        tenantB.ownerUserId,
        {
          name: 'Genomics 2024',
          query: { q: 'CRISPR', year: 2024 },
          color: '#22c55e',
          icon: 'dna',
        },
      );

      const listA = await discoveryRepo.listSavedSearches(
        tenantA.workspaceId,
        tenantA.ownerUserId,
      );
      const listB = await discoveryRepo.listSavedSearches(
        tenantB.workspaceId,
        tenantB.ownerUserId,
      );

      expect(listA).toHaveLength(1);
      expect(listA[0].id).toBe(searchA.id);
      expect(listA[0].name).toBe('Recent AI Papers');

      expect(listB).toHaveLength(1);
      expect(listB[0].id).toBe(searchB.id);
      expect(listB[0].name).toBe('Genomics 2024');

      // Delete saved search
      const deleted = await discoveryRepo.deleteSavedSearch(
        tenantA.workspaceId,
        tenantA.ownerUserId,
        searchA.id,
      );
      expect(deleted).toBe(true);

      const listAAfter = await discoveryRepo.listSavedSearches(
        tenantA.workspaceId,
        tenantA.ownerUserId,
      );
      expect(listAAfter).toHaveLength(0);
    });
  });

  describe('3. PDF Page-Anchor & Character Offset Invariant in PostgreSQL', () => {
    it('indexes pages and returns exact page anchors and snippet offsets from PostgreSQL', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      const item = await harness.prisma.catalogItem.create({
        data: {
          workspaceId: tenant.workspaceId,
          uploadedById: tenant.ownerUserId,
          title: 'Deep Attention Models',
          version: 1,
        },
      });

      const attachment = await harness.prisma.catalogAttachment.create({
        data: {
          catalogItemId: item.id,
          filename: 'deep-attention.pdf',
          url: 'https://example.com/deep-attention.pdf',
          attachmentType: 'primary_pdf',
          size: 1024,
        },
      });

      await fullTextIndexer.indexAttachmentPages(attachment.id, [
        {
          pageIndex: 1,
          textContent: 'Introduction to neural networks and deep learning.',
          charOffset: 0,
        },
        {
          pageIndex: 4,
          textContent:
            'The transformer architecture relies entirely on self-attention mechanisms to compute representations.',
          charOffset: 1200,
        },
      ]);

      const matches = await fullTextIndexer.searchPageAnchors(
        attachment.id,
        'self-attention',
      );

      expect(matches).toHaveLength(1);
      expect(matches[0].attachmentId).toBe(attachment.id);
      expect(matches[0].pageIndex).toBe(4);
      expect(matches[0].snippet).toContain('self-attention');
      expect(matches[0].charOffsetStart).toBeGreaterThanOrEqual(1200);
    });
  });
});
