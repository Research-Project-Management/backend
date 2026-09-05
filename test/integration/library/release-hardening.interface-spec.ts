import {
  LibraryTestHarness,
  TestWorkspaceFixture,
} from './library-test-harness';
import { IngestionService } from '../../../src/modules/library/ingestion/ingestion.service';
import { CatalogService } from '../../../src/modules/library/items/items.service';
import { CitationService } from '../../../src/modules/library/citation/citation.service';
import {
  STORAGE_PORT,
  IStoragePort,
} from '../../../src/modules/storage/storage.port';
import { R2Service } from '../../../src/modules/storage/r2/r2.service';
import * as crypto from 'crypto';

describe('Library Critical Path Release Hardening (14-Step Invariant Suite)', () => {
  let harness: LibraryTestHarness;
  let workspace: TestWorkspaceFixture;
  let workspaceB: TestWorkspaceFixture;
  let ingestionService: IngestionService;
  let catalogService: CatalogService;
  let citationService: CitationService;
  let storagePort: IStoragePort;
  let r2Service: R2Service;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    workspace = await harness.seedWorkspaceFixture();
    workspaceB = await harness.seedWorkspaceFixture();
    ingestionService = harness.moduleRef.get(IngestionService);
    catalogService = harness.moduleRef.get(CatalogService);
    citationService = harness.moduleRef.get(CitationService);
    storagePort = harness.moduleRef.get<IStoragePort>(STORAGE_PORT);
    r2Service = harness.moduleRef.get(R2Service);
  }, 60000);

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  }, 30000);

  it('executes complete critical release path: Login → Upload PDF → fileId → Ingest → Deduplicate → Relations → Workspace Isolation', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    // STEP 1 & 2: User and Workspace exist and verified
    expect(wsId).toBeDefined();
    expect(userId).toBeDefined();

    // STEP 3: Setup real R2 storage upload for PDF ingestion
    const rawPdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF',
    );
    const storageKey = `workspaces/${wsId}/papers/${Date.now()}-quantum.pdf`;
    const uploadRes = await r2Service.uploadBuffer(
      storageKey,
      rawPdfBuffer,
      'application/pdf',
    );

    const fileId = `file-${crypto.randomUUID()}`;
    await harness.prisma.file.create({
      data: {
        id: fileId,
        filename: 'quantum_computing_advances.pdf',
        mimeType: 'application/pdf',
        size: rawPdfBuffer.length,
        url: uploadRes.url,
        authorId: userId,
        workspaceId: wsId,
      },
    });

    // STEP 4: Ingestion flow (create Item A via PDF fileId)
    const ingestResultA = await ingestionService.ingest({
      source: 'pdf',
      workspaceId: wsId,
      userId,
      fileId,
    });

    expect(ingestResultA.status).toBe('completed');
    expect(ingestResultA.itemId).toBeDefined();
    const itemAId = ingestResultA.itemId!;

    // STEP 5: Attachment verification via StoragePort
    const storedFile = await storagePort.readOwnedFile({
      workspaceId: wsId,
      fileId,
    });
    expect(storedFile.fileId).toBe(fileId);
    expect(storedFile.buffer.equals(rawPdfBuffer)).toBe(true);

    // STEP 6: Repeat upload dedup check (ingesting same fileId returns deduplicated result)
    const duplicateIngest = await ingestionService.ingest({
      source: 'pdf',
      workspaceId: wsId,
      userId,
      fileId,
    });
    expect(duplicateIngest.deduplicated).toBe(true);
    expect(duplicateIngest.itemId).toBe(itemAId);

    // Ingest Item B for relation testing
    const ingestResultB = await ingestionService.ingest({
      source: 'bibtex',
      workspaceId: wsId,
      userId,
      content: `@article{preskill2021,\n  title={Quantum Computing in the NISQ Era and Beyond},\n  author={Preskill, John},\n  journal={Quantum},\n  year={2021}\n}`,
    });
    expect(ingestResultB.status).toBe('completed');
    expect(ingestResultB.itemId).toBeDefined();
    const itemBId = ingestResultB.itemId!;

    // STEP 7: Verify Metadata
    const itemA = await catalogService.getItem(wsId, itemAId);
    const itemB = await catalogService.getItem(wsId, itemBId);
    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(itemB?.title).toContain('Quantum Computing');

    // STEP 8: Verify Items appear in Library list exactly once
    const listResponse = await catalogService.listItems(wsId, { limit: 50 });
    const matchingA = listResponse.items.filter((i: any) => i.id === itemAId);
    const matchingB = listResponse.items.filter((i: any) => i.id === itemBId);
    expect(matchingA.length).toBe(1);
    expect(matchingB.length).toBe(1);

    // STEP 9: Manual metadata update
    const updatedA = await catalogService.updateItem(
      wsId,
      itemAId,
      itemA!.version,
      {
        title: 'Quantum Computing Advances in 2026',
      },
    );
    expect(updatedA.title).toBe('Quantum Computing Advances in 2026');

    // STEP 10: Citation Formatting (load contributors from DB for accurate author names)
    const bibtexCitation = await citationService.formatItemById(
      wsId,
      itemBId,
      'bibtex',
    );
    expect(bibtexCitation.bibliography).toContain('@article');
    expect(bibtexCitation.bibliography).toContain('Preskill');

    // STEP 11: Directed relation link (Item A -> Item B)
    const linkResult = await catalogService.linkItems(wsId, itemAId, {
      targetItemId: itemBId,
      relationType: 'cites',
      note: 'Foundational quantum reference',
    });
    expect(linkResult.success).toBe(true);
    expect(linkResult.link.targetItemId).toBe(itemBId);

    // STEP 12: Asymmetry verification (Item A links B, but B does NOT link A)
    const relsFromA = await catalogService.getRelatedItems(wsId, itemAId);
    expect(relsFromA.total).toBe(1);
    expect(relsFromA.relatedItems[0].targetItemId).toBe(itemBId);

    const relsFromB = await catalogService.getRelatedItems(wsId, itemBId);
    expect(relsFromB.total).toBe(0);

    // STEP 13: Directed unlink
    const unlinkResult = await catalogService.unlinkItems(
      wsId,
      itemAId,
      itemBId,
    );
    expect(unlinkResult.success).toBe(true);
    const relsAfterUnlink = await catalogService.getRelatedItems(wsId, itemAId);
    expect(relsAfterUnlink.total).toBe(0);

    // STEP 14: Workspace isolation (Workspace B cannot access Workspace A item)
    const crossAccess = await catalogService.getItem(
      workspaceB.workspaceId,
      itemAId,
    );
    expect(crossAccess).toBeNull();

    // Cleanup
    await r2Service.deleteObject(storageKey);
  }, 60000);
});
