import {
  LibraryTestHarness,
  TestWorkspaceFixture,
} from '../library-test-harness';
import { IngestionService } from '../../../../src/modules/library/ingestion/ingestion.service';
import {
  CANONICAL_METADATA_SERVICE,
  CanonicalMetadataResolver,
} from '../../../../src/modules/library/ingestion/metadata/metadata.contracts';
import { R2Service } from '../../../../src/modules/storage/r2/r2.service';

describe('Integration: Database-Backed Deduplication & Concurrency Race Resistance', () => {
  let harness: LibraryTestHarness;
  let fixtureA: TestWorkspaceFixture;
  let fixtureB: TestWorkspaceFixture;
  let ingestionService: IngestionService;
  let metadataService: CanonicalMetadataResolver;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    fixtureA = await harness.seedWorkspaceFixture();
    fixtureB = await harness.seedWorkspaceFixture();

    ingestionService = harness.moduleRef.get(IngestionService);
    metadataService = harness.moduleRef.get<CanonicalMetadataResolver>(
      CANONICAL_METADATA_SERVICE,
    );
  });

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('1. Concurrent DOI Ingestion Deduplication', () => {
    it('guarantees exactly ONE CatalogItem and ONE LibraryDedupClaim when 5 concurrent requests hit the same DOI', async () => {
      const doi = '10.1038/s41586-023-00001-concurrent';
      const mockMeta = {
        title: 'Concurrent Quantum Computing Breakthrough',
        authors: ['Eve Researcher'],
        year: 2024,
      };

      jest.spyOn(metadataService, 'resolve').mockImplementation(async () => ({
        query: doi,
        queryType: 'DOI' as const,
        canonicalId: `doi:${doi}`,
        metadata: mockMeta,
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      }));

      // Dispatch 5 concurrent ingestion requests
      const promises = Array.from({ length: 5 }, () =>
        ingestionService.ingest({
          source: 'doi',
          workspaceId: fixtureA.workspaceId,
          userId: fixtureA.ownerUserId,
          doi,
        }),
      );

      const results = await Promise.all(promises);

      // All 5 must succeed
      for (const res of results) {
        expect(res.status).toBe('completed');
        expect(res.itemId).toBeDefined();
      }

      // Exactly one winner was non-deduplicated, 4 were deduplicated
      const winnerCount = results.filter((r) => !r.deduplicated).length;
      const deduplicatedCount = results.filter((r) => r.deduplicated).length;
      expect(winnerCount).toBe(1);
      expect(deduplicatedCount).toBe(4);

      // All returned the same itemId
      const uniqueItemIds = new Set(results.map((r) => r.itemId));
      expect(uniqueItemIds.size).toBe(1);

      // Verify exact count in database
      const dbItems = await harness.prisma.catalogItem.findMany({
        where: {
          workspaceId: fixtureA.workspaceId,
          doi: doi.toLowerCase(),
          deletedAt: null,
        },
      });
      expect(dbItems.length).toBe(1);

      const dbClaims = await (harness.prisma as any).libraryDedupClaim.findMany(
        {
          where: {
            workspaceId: fixtureA.workspaceId,
            claimType: 'doi',
            claimValue: doi.toLowerCase(),
          },
        },
      );
      expect(dbClaims.length).toBe(1);
    });
  });

  describe('2. Multi-Tenant Workspace Isolation for Deduplication Claims', () => {
    it('permits the same DOI to be ingested once per independent workspace', async () => {
      const doi = '10.1038/s41586-multitenant-isolated';
      const mockMeta = {
        title: 'Cross-Tenant Isolated Paper',
        authors: ['Grace Hopper'],
        year: 2025,
      };

      jest.spyOn(metadataService, 'resolve').mockImplementation(async () => ({
        query: doi,
        queryType: 'DOI' as const,
        canonicalId: `doi:${doi}`,
        metadata: mockMeta,
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      }));

      const resA = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixtureA.workspaceId,
        userId: fixtureA.ownerUserId,
        doi,
      });

      const resB = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixtureB.workspaceId,
        userId: fixtureB.ownerUserId,
        doi,
      });

      expect(resA.deduplicated).toBe(false);
      expect(resB.deduplicated).toBe(false);
      expect(resA.itemId).not.toBe(resB.itemId);

      const claims = await (harness.prisma as any).libraryDedupClaim.findMany({
        where: {
          claimType: 'doi',
          claimValue: doi.toLowerCase(),
        },
      });
      expect(claims.length).toBe(2);
    });
  });

  describe('3. Concurrent PDF SHA-256 Checksum Deduplication', () => {
    it('deduplicates identical PDF buffers and maintains exactly one item in workspace', async () => {
      const fileId = `file-${Date.now()}`;
      await harness.prisma.file.create({
        data: {
          id: fileId,
          filename: 'concurrent-test.pdf',
          authorId: fixtureA.ownerUserId,
          workspaceId: fixtureA.workspaceId,
          url: `/api/files/r2/workspaces/${fixtureA.workspaceId}/concurrent-test.pdf`,
        },
      });

      const fakePdfBuffer = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Title (Concurrent PDF Deduplication Test) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF',
      );

      const r2Service = harness.moduleRef.get(R2Service, { strict: false });
      if (r2Service) {
        jest.spyOn(r2Service, 'getObjectStream').mockResolvedValue({
          Body: [fakePdfBuffer],
        } as any);
      }

      const promises = Array.from({ length: 4 }, () =>
        ingestionService.ingest({
          source: 'pdf',
          workspaceId: fixtureA.workspaceId,
          userId: fixtureA.ownerUserId,
          fileId,
          filename: 'concurrent-test.pdf',
        }),
      );

      const results = await Promise.all(promises);

      const winnerCount = results.filter((r) => !r.deduplicated).length;
      const deduplicatedCount = results.filter((r) => r.deduplicated).length;
      expect(winnerCount).toBe(1);
      expect(deduplicatedCount).toBe(3);

      const uniqueItemIds = new Set(results.map((r) => r.itemId));
      expect(uniqueItemIds.size).toBe(1);
    });
  });

  describe('4. Dedup Collision Recovery with Soft-Deleted Item', () => {
    it('restores soft-deleted item and avoids creating orphaned records when matching DOI is re-ingested', async () => {
      const doi = '10.1038/s41586-softdelete-recovery';
      const mockMeta = {
        title: 'Soft-Deleted Paper Restored',
        authors: ['Alan Turing'],
        year: 2026,
      };

      jest.spyOn(metadataService, 'resolve').mockImplementation(async () => ({
        query: doi,
        queryType: 'DOI' as const,
        canonicalId: `doi:${doi}`,
        metadata: mockMeta,
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      }));

      // Initial ingestion
      const initial = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixtureA.workspaceId,
        userId: fixtureA.ownerUserId,
        doi,
      });

      expect(initial.deduplicated).toBe(false);

      // Soft delete the item
      await harness.prisma.catalogItem.update({
        where: { id: initial.itemId },
        data: { deletedAt: new Date() },
      });

      // Re-ingest the same DOI
      const reingest = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixtureA.workspaceId,
        userId: fixtureA.ownerUserId,
        doi,
      });

      expect(reingest.status).toBe('completed');
      expect(reingest.itemId).toBe(initial.itemId);

      // Verify item was restored (deletedAt is null)
      const restored = await harness.prisma.catalogItem.findUnique({
        where: { id: initial.itemId },
      });
      expect(restored?.deletedAt).toBeNull();
    });
  });
});
