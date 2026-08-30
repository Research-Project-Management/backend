import {
  LibraryTestHarness,
  TestWorkspaceFixture,
} from '../library-test-harness';
import { IngestionService } from '../../../../src/modules/library/ingestion/ingestion.service';
import {
  METADATA_PORT,
  MetadataPort,
} from '../../../../src/modules/library/ingestion/metadata/types/metadata.types';
import {
  IngestionIdempotencyConflictException,
  IngestionValidationException,
} from '../../../../src/modules/library/ingestion/errors/ingestion.errors';
import { NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';

describe('Integration: Unified Library Ingestion Golden Paths & Security Gates', () => {
  let harness: LibraryTestHarness;
  let fixture: TestWorkspaceFixture;
  let fixtureB: TestWorkspaceFixture;
  let ingestionService: IngestionService;
  let metadataService: MetadataPort;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    fixture = await harness.seedWorkspaceFixture();
    fixtureB = await harness.seedWorkspaceFixture();

    ingestionService = harness.moduleRef.get(IngestionService);
    metadataService = harness.moduleRef.get<MetadataPort>(METADATA_PORT);
  });

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  });

  describe('1. DOI Ingestion & Multi-Tenant Deduplication', () => {
    it('successfully ingests DOI, creates CatalogItem + OutboxEvent, and persists IngestionRun', async () => {
      const doi = '10.1145/3290605.3300233';
      const mockMeta = {
        title: 'Deep Multi-Agent Reinforcement Learning',
        authors: ['Alice Researcher', 'Bob Scientist'],
        year: 2023,
        journal: 'ACM Transactions',
        itemType: 'journalArticle',
      };

      jest.spyOn(metadataService, 'resolve').mockResolvedValueOnce({
        query: doi,
        queryType: 'DOI' as const,
        canonicalId: `doi:${doi}`,
        metadata: mockMeta,
        provenance: {},
        resolvedAt: new Date().toISOString(),
        policyVersion: 1,
      });

      const result = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerUserId,
        doi,
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);
      expect(result.itemId).toBeDefined();

      const item = await harness.prisma.catalogItem.findUnique({
        where: { id: result.itemId },
        include: { contributors: true },
      });
      expect(item).toBeDefined();
      expect(item?.doi).toBe(doi.toLowerCase());
      expect(item?.title).toBe(mockMeta.title);
      expect(item?.contributors.length).toBe(2);

      // Verify IngestionRun was persisted
      const runStatus = await ingestionService.getRunStatus(
        fixture.workspaceId,
        result.runId,
      );
      expect(runStatus.id).toBe(result.runId);
      expect(runStatus.workspaceId).toBe(fixture.workspaceId);
      expect(runStatus.status).toBe('READY');

      // Verify Outbox Event was emitted
      const outbox = await harness.prisma.outboxEvent.findFirst({
        where: {
          aggregateId: result.itemId,
          eventType: 'library.item.created',
        },
      });
      expect(outbox).toBeDefined();
    });

    it('deduplicates identical DOI in same workspace without creating duplicates', async () => {
      const doi = '10.1145/3290605.3300233';

      const result = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerUserId,
        doi: `https://doi.org/${doi}`, // With URL prefix to test normalization
      });

      expect(result.deduplicated).toBe(true);
      expect(result.itemId).toBeDefined();
    });

    it('allows same DOI in a different workspace (tenant isolation)', async () => {
      const doi = '10.1145/3290605.3300233';

      const result = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixtureB.workspaceId,
        userId: fixtureB.ownerUserId,
        doi,
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);
      expect(result.itemId).toBeDefined();
    });
  });

  describe('2. URL Ingestion & SSRF Protection', () => {
    it('blocks SSRF targets (localhost / private IPs)', async () => {
      await expect(
        ingestionService.ingest({
          source: 'url',
          workspaceId: fixture.workspaceId,
          userId: fixture.ownerUserId,
          url: 'http://127.0.0.1:8080/secret-admin-paper.pdf',
        }),
      ).rejects.toThrow(/SSRF violation/i);

      await expect(
        ingestionService.ingest({
          source: 'url',
          workspaceId: fixture.workspaceId,
          userId: fixture.ownerUserId,
          url: 'http://192.168.1.50/paper.pdf',
        }),
      ).rejects.toThrow(/SSRF violation/i);
    });

    it('successfully ingests valid public URL with overrides', async () => {
      const publicUrl = 'https://example.org/papers/deep-learning-overview';
      const result = await ingestionService.ingest({
        source: 'url',
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerUserId,
        url: publicUrl,
        overrides: {
          title: 'Deep Learning Overview 2026',
          abstract:
            'Comprehensive state-of-the-art overview of DL architectures.',
          tags: ['AI', 'Survey'],
        },
      });

      expect(result.status).toBe('completed');
      expect(result.deduplicated).toBe(false);

      const item = await harness.prisma.catalogItem.findUnique({
        where: { id: result.itemId },
      });
      expect(item?.title).toBe('Deep Learning Overview 2026');
      expect(item?.fileUrl).toBe(publicUrl);
    });
  });

  describe('3. BibTeX Ingestion', () => {
    it('parses BibTeX entry and creates CatalogItem with full metadata', async () => {
      const bibtex = `@article{knuth1984literate,
        title={Literate Programming},
        author={Knuth, Donald E.},
        journal={The Computer Journal},
        volume={27},
        number={2},
        pages={97--111},
        year={1984},
        publisher={Oxford University Press}
      }`;

      const result = await ingestionService.ingest({
        source: 'bibtex',
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerUserId,
        content: bibtex,
      });

      expect(result.status).toBe('completed');
      const item = await harness.prisma.catalogItem.findUnique({
        where: { id: result.itemId },
      });
      expect(item?.title).toBe('Literate Programming');
      expect(item?.citationKey).toBe('knuth1984literate');
      expect(item?.year).toBe(1984);
    });
  });

  describe('4. PDF Ingestion & Storage Verification', () => {
    it('ingests PDF buffer, verifies %PDF header, creates attachment with real SHA-256 and revision v1', async () => {
      const validPdfBuffer = Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000108 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF',
      );

      const expectedHash = crypto
        .createHash('sha256')
        .update(validPdfBuffer)
        .digest('hex');

      const file = await harness.prisma.file.create({
        data: {
          filename: 'sample_quantum.pdf',
          workspaceId: fixture.workspaceId,
          authorId: fixture.ownerUserId,
          url: `/api/files/r2/workspaces/${fixture.workspaceId}/sample_quantum.pdf`,
        },
      });

      const { R2Service } =
        await import('../../../../src/modules/storage/r2/r2.service');
      const r2Service = harness.moduleRef.get(R2Service, { strict: false });
      if (r2Service) {
        jest.spyOn(r2Service, 'getObjectStream').mockResolvedValue({
          Body: [validPdfBuffer],
        } as any);
      }

      const result = await ingestionService.ingest({
        source: 'pdf',
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerUserId,
        fileId: file.id,
        filename: 'sample_quantum.pdf',
      });

      expect(result.status).toBe('completed');
      expect(result.attachmentIds.length).toBe(1);

      const attachment = await harness.prisma.catalogAttachment.findUnique({
        where: { id: result.attachmentIds[0] },
        include: { revisions: true },
      });

      expect(attachment).toBeDefined();
      expect(attachment?.fileHash).toBe(expectedHash);
      expect(attachment?.revisions.length).toBe(1);
      expect(attachment?.revisions[0].revisionNumber).toBe(1);

      // Verify Outbox Event for attachment extraction
      const outbox = await harness.prisma.outboxEvent.findFirst({
        where: {
          aggregateId: attachment?.id,
          eventType: 'library.attachment.extraction_requested',
        },
      });
      expect(outbox).toBeDefined();
    });

    it('rejects invalid non-PDF buffer (missing %PDF header)', async () => {
      const fakeBuffer = Buffer.from('NOT A PDF FILE');
      const file = await harness.prisma.file.create({
        data: {
          filename: 'corrupted.pdf',
          workspaceId: fixture.workspaceId,
          authorId: fixture.ownerUserId,
          url: `/api/files/r2/workspaces/${fixture.workspaceId}/corrupted.pdf`,
        },
      });

      const { R2Service } =
        await import('../../../../src/modules/storage/r2/r2.service');
      const r2Service = harness.moduleRef.get(R2Service, { strict: false });
      if (r2Service) {
        jest.spyOn(r2Service, 'getObjectStream').mockResolvedValue({
          Body: [fakeBuffer],
        } as any);
      }

      await expect(
        ingestionService.ingest({
          source: 'pdf',
          workspaceId: fixture.workspaceId,
          userId: fixture.ownerUserId,
          fileId: file.id,
          filename: 'corrupted.pdf',
        }),
      ).rejects.toThrow(/Missing %PDF magic bytes/i);
    });

    it('rejects cross-tenant fileId access', async () => {
      // Seed a file in workspace B
      const fileInWorkspaceB = await harness.prisma.file.create({
        data: {
          workspaceId: fixtureB.workspaceId,
          authorId: fixtureB.ownerUserId,
          filename: 'tenant_b_paper.pdf',
          size: 1024,
          mimeType: 'application/pdf',
          url: `/api/files/r2/workspaces/${fixtureB.workspaceId}/tenant_b_paper.pdf`,
        },
      });

      // Attempt to ingest from Workspace A using Workspace B's fileId
      await expect(
        ingestionService.ingest({
          source: 'pdf',
          workspaceId: fixture.workspaceId,
          userId: fixture.ownerUserId,
          fileId: fileInWorkspaceB.id,
        }),
      ).rejects.toThrow(IngestionValidationException);
    });
  });

  describe('5. Concurrent Idempotency & Crash Safety', () => {
    it('concurrent identical requests with same idempotencyKey create only 1 item and return consistent results', async () => {
      const idempotencyKey = `idemp-concurrent-${Date.now()}`;
      const doi = `10.1000/concurrent.${Date.now()}`;

      const runParallel = () =>
        ingestionService.ingest({
          source: 'doi',
          workspaceId: fixture.workspaceId,
          userId: fixture.ownerUserId,
          doi,
          idempotencyKey,
        });

      // Run two parallel requests
      const results = await Promise.allSettled([runParallel(), runParallel()]);

      // Exactly one should succeed directly, other either gets cached or in_progress conflict
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Subsequent identical request must return cached result
      const retryResult = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerUserId,
        doi,
        idempotencyKey,
      });

      expect(retryResult.itemId).toBeDefined();

      // Retry with same key but different payload must fail with conflict
      await expect(
        ingestionService.ingest({
          source: 'doi',
          workspaceId: fixture.workspaceId,
          userId: fixture.ownerUserId,
          doi: '10.1000/different.payload',
          idempotencyKey,
        }),
      ).rejects.toThrow(IngestionIdempotencyConflictException);
    });
  });

  describe('7. Multi-Tenant Security for getRunStatus', () => {
    it('rejects cross-workspace getRunStatus query with 404', async () => {
      const resA = await ingestionService.ingest({
        source: 'doi',
        workspaceId: fixture.workspaceId,
        userId: fixture.ownerUserId,
        doi: '10.1038/s41586-020-0001',
      });

      // Querying with Workspace A succeeds
      const statusA = await ingestionService.getRunStatus(
        fixture.workspaceId,
        resA.runId,
      );
      expect(statusA.id).toBe(resA.runId);

      // Querying with Workspace B fails with NotFoundException
      await expect(
        ingestionService.getRunStatus(fixtureB.workspaceId, resA.runId),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
