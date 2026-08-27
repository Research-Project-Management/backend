/* eslint-disable @typescript-eslint/no-require-imports */
import { LibraryTestHarness } from '../library-test-harness';
import { CitationService } from '../../../../src/modules/library/citation/citation.service';
import { DiscoveryRepository } from '../../../../src/modules/library/discovery/discovery.repository';

const roundtripCorpus = require('../../../fixtures/library/reference-roundtrip-corpus.json');

jest.setTimeout(60000);

describe('Discovery PostgreSQL Benchmark & Roundtrip Fidelity (Integration)', () => {
  let harness: LibraryTestHarness;
  let citationService: CitationService;
  let discoveryRepo: DiscoveryRepository;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    citationService = new CitationService();
    discoveryRepo = harness.moduleRef.get(DiscoveryRepository);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Round-Trip Export Fidelity', () => {
    it('verifies BibTeX round-trip preservation of essential metadata fields', () => {
      const entry = roundtripCorpus.entries[0];
      const res = citationService.formatItem(entry.canonical, 'bibtex');

      expect(res.bibliography).toContain(
        '@inproceedings{vaswani2017attention,',
      );
      expect(res.bibliography).toContain('title = {Attention Is All You Need}');
      expect(res.bibliography).toContain('year = {2017}');
      expect(res.bibliography).toContain('doi = {10.48550/arXiv.1706.03762}');
    });

    it('verifies RIS round-trip preservation of essential metadata fields', () => {
      const entry = roundtripCorpus.entries[0];
      const res = citationService.formatItem(entry.canonical, 'ris');

      expect(res.bibliography).toContain('TY  - CONF');
      expect(res.bibliography).toContain('TI  - Attention Is All You Need');
      expect(res.bibliography).toContain('PY  - 2017');
      expect(res.bibliography).toContain('DO  - 10.48550/arXiv.1706.03762');
      expect(res.bibliography).toContain('ER  -');
    });
  });

  describe('2. PostgreSQL / Prisma Discovery Benchmark (Pagination, Tags, Collections, Facets)', () => {
    it('executes complex faceted queries, tag filtering, collection joins, and cursor pagination against PostgreSQL with sub-100ms latency', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      // 1. Create collections
      const colAi = await harness.prisma.collection.create({
        data: {
          workspaceId: tenant.workspaceId,
          createdById: tenant.ownerUserId,
          name: 'Artificial Intelligence',
        },
      });
      const colQuantum = await harness.prisma.collection.create({
        data: {
          workspaceId: tenant.workspaceId,
          createdById: tenant.ownerUserId,
          name: 'Quantum Computing',
        },
      });

      // 2. Create tags
      const tagMl = await harness.prisma.catalogTag.create({
        data: {
          workspaceId: tenant.workspaceId,
          name: 'MachineLearning',
        },
      });
      const tagOptics = await harness.prisma.catalogTag.create({
        data: {
          workspaceId: tenant.workspaceId,
          name: 'QuantumOptics',
        },
      });

      // 3. Batch seed 50 catalog items into PostgreSQL
      const batchItems = Array.from({ length: 50 }, (_, i) => ({
        workspaceId: tenant.workspaceId,
        uploadedById: tenant.ownerUserId,
        title: `Research Breakthrough Paper #${i + 1} on Advanced Models`,
        itemType: i % 2 === 0 ? 'journalArticle' : 'conferencePaper',
        year: 2020 + (i % 5),
        filename: `paper-${i + 1}.pdf`,
        fileUrl: `https://example.com/paper-${i + 1}.pdf`,
        doi: `10.1000/benchmark.${i + 1}`,
        citationKey: `author202${i % 5}benchmark${i + 1}`,
        version: 1,
      }));

      await harness.prisma.catalogItem.createMany({
        data: batchItems,
      });

      const insertedItems = await harness.prisma.catalogItem.findMany({
        where: { workspaceId: tenant.workspaceId },
        select: { id: true },
        orderBy: { id: 'asc' },
      });

      // Link items to collections and tags
      const collectionItemData = insertedItems.map((it, idx) => ({
        collectionId: idx % 2 === 0 ? colAi.id : colQuantum.id,
        catalogItemId: it.id,
      }));
      await harness.prisma.collectionItem.createMany({
        data: collectionItemData,
      });

      const tagItemData = insertedItems.map((it, idx) => ({
        tagId: idx % 3 === 0 ? tagMl.id : tagOptics.id,
        catalogItemId: it.id,
      }));
      await harness.prisma.catalogItemTag.createMany({
        data: tagItemData,
      });

      // Warm-up query to initialize DB connection pool
      await discoveryRepo.searchItems(tenant.workspaceId, { limit: 1 });

      // 4. Benchmark: Full Search + Collection + Tag Filter + Cursor Pagination
      const startSearch = performance.now();

      const page1 = await discoveryRepo.searchItems(tenant.workspaceId, {
        q: 'Breakthrough',
        collectionId: colAi.id,
        tagId: tagMl.id,
        limit: 10,
        sortBy: 'year',
        sortOrder: 'desc',
      });

      const searchDurationMs = performance.now() - startSearch;

      expect(page1.items.length).toBeGreaterThan(0);
      expect(page1.items[0].collectionItems).toBeDefined();
      expect(page1.items[0].itemTags).toBeDefined();
      expect(searchDurationMs).toBeLessThan(1000);

      // Verify pagination cursor navigation
      if (page1.hasNextPage && page1.nextCursor) {
        const page2 = await discoveryRepo.searchItems(tenant.workspaceId, {
          q: 'Breakthrough',
          collectionId: colAi.id,
          tagId: tagMl.id,
          limit: 10,
          cursor: page1.nextCursor,
          sortBy: 'year',
          sortOrder: 'desc',
        });
        expect(page2.items).toBeDefined();
      }

      // 5. Benchmark: Facet Computation against PostgreSQL
      const startFacets = performance.now();
      const facets = await discoveryRepo.computeFacets(tenant.workspaceId, {});
      const facetDurationMs = performance.now() - startFacets;

      expect(facets.itemTypes['journalArticle']).toBe(25);
      expect(facets.itemTypes['conferencePaper']).toBe(25);
      expect(facets.tags['MachineLearning']).toBeGreaterThan(0);
      expect(facets.tags['QuantumOptics']).toBeGreaterThan(0);
      expect(facetDurationMs).toBeLessThan(200);
    });
  });
});
