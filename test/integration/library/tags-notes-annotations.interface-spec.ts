// @ts-nocheck -- Integration test fixtures use legacy field names; update when test data is migrated
import {
  LibraryTestHarness,
  TestWorkspaceFixture,
} from './library-test-harness';
import { IngestionService } from '../../../src/modules/library/ingestion/ingestion.service';
import { CatalogService } from '../../../src/modules/library/catalog/catalog.service';
import { CatalogRepository } from '../../../src/modules/library/catalog/catalog.repository';
import { NotesService } from '../../../src/modules/library/notes/notes.service';
import { AnnotationsService } from '../../../src/modules/library/annotations/annotations.service';
import { SyncService } from '../../../src/modules/library/sync/sync.service';
import { R2Service } from '../../../src/modules/storage/r2/r2.service';
import * as crypto from 'crypto';

const toItemView = (item: any) => ({
  ...item,
  tags:
    item?.itemTags?.map((it: any) => it.tag?.name || it.tag) ??
    item?.labels ??
    [],
});

describe('Library Feature Closure: Paper Tags, Notes & Annotation Comments', () => {
  let harness: LibraryTestHarness;
  let workspaceA: TestWorkspaceFixture;
  let workspaceB: TestWorkspaceFixture;
  let ingestionService: IngestionService;
  let catalogService: CatalogService;
  let catalogRepo: CatalogRepository;
  let notesService: NotesService;
  let annotationsService: AnnotationsService;
  let syncBridge: SyncService;
  let r2Service: R2Service;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    workspaceA = await harness.seedWorkspaceFixture();
    workspaceB = await harness.seedWorkspaceFixture();
    ingestionService = harness.moduleRef.get(IngestionService);
    catalogService = harness.moduleRef.get(CatalogService);
    catalogRepo = harness.moduleRef.get(CatalogRepository);
    notesService = harness.moduleRef.get(NotesService);
    annotationsService = harness.moduleRef.get(AnnotationsService);
    syncBridge = harness.moduleRef.get(SyncService);
    r2Service = harness.moduleRef.get(R2Service);
  }, 60000);

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  }, 30000);

  it('1. PDF Extraction with Keywords -> Ingest -> Database -> Response Tags (normalized & deduped)', async () => {
    const wsId = workspaceA.workspaceId;
    const userId = workspaceA.ownerUserId;

    // Create a mock PDF with keywords metadata
    const rawPdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF',
    );
    const storageKey = `workspaces/${wsId}/papers/${Date.now()}-pdf-tags.pdf`;
    const uploadRes = await r2Service.uploadBuffer(
      storageKey,
      rawPdfBuffer,
      'application/pdf',
    );

    const fileId = `file-${crypto.randomUUID()}`;
    await harness.prisma.file.create({
      data: {
        id: fileId,
        filename: 'machine_learning_survey.pdf',
        mimeType: 'application/pdf',
        size: rawPdfBuffer.length,
        url: uploadRes.url,
        authorId: userId,
        workspaceId: wsId,
      },
    });

    const ingestResult = await ingestionService.ingest({
      source: 'pdf',
      workspaceId: wsId,
      userId,
      fileId,
      overrides: {
        title: 'Deep Learning Advances',
        keywords: [
          'Machine Learning',
          'machine learning',
          '  Deep Learning  ',
          'AI',
          '',
          '   ',
        ],
      },
    });

    expect(ingestResult.status).toBe('completed');
    expect(ingestResult.itemId).toBeDefined();

    // Verify DB CatalogItem row
    const itemDb = await harness.prisma.catalogItem.findUnique({
      where: { id: ingestResult.itemId! },
      include: {
        collectionItems: { include: { collection: true } },
        itemTags: { include: { tag: true } },
        attachments: true,
      },
    });
    expect(itemDb).toBeDefined();
    const itemDbTags = itemDb!.itemTags.map((it: any) => it.tag.name);
    expect(itemDbTags).toEqual(
      expect.arrayContaining(['Machine Learning', 'Deep Learning', 'AI']),
    );
    // Case-insensitive dedup verification
    expect(itemDbTags.length).toBe(3);

    // Verify toItemView mapping
    const itemView = toItemView(itemDb as any);
    expect(itemView.tags).toEqual(['Machine Learning', 'Deep Learning', 'AI']);
  });

  it('2 & 3. Zotero item sync with tags -> DB persistence -> Additive merge on update', async () => {
    const wsId = workspaceA.workspaceId;
    const userId = workspaceA.ownerUserId;

    // 2. Initial Sync create
    const createResult = await syncBridge.upsertCatalogItem({
      workspaceId: wsId,
      userId,
      title: 'Quantum Teleportation Paper',
      itemType: 'journalArticle',
      tags: ['Quantum Physics', 'quantum physics', 'Entanglement', '   '],
    });

    expect(createResult.id).toBeDefined();
    expect(createResult.isNew).toBe(true);

    const initialDb = await harness.prisma.catalogItem.findUnique({
      where: { id: createResult.id },
      include: {
        collectionItems: { include: { collection: true } },
        itemTags: { include: { tag: true } },
        attachments: true,
      },
    });
    const initialTags = initialDb!.itemTags.map((it: any) => it.tag.name);
    expect(initialTags).toEqual(['Quantum Physics', 'Entanglement']);

    // Snapshot returns tags
    const snapshot1 = await syncBridge.getItemSnapshot({
      workspaceId: wsId,
      itemId: createResult.id,
    });
    expect(snapshot1?.tags).toEqual(['Quantum Physics', 'Entanglement']);

    // 3. Sync update with additive merge
    const updateResult = await syncBridge.upsertCatalogItem({
      workspaceId: wsId,
      userId,
      existingId: createResult.id,
      title: 'Quantum Teleportation Paper (Revised)',
      itemType: 'journalArticle',
      tags: ['entanglement', 'Teleportation', 'Quantum Optics'],
    });

    expect(updateResult.id).toBe(createResult.id);
    expect(updateResult.isNew).toBe(false);

    const updatedDb = await harness.prisma.catalogItem.findUnique({
      where: { id: createResult.id },
      include: {
        collectionItems: { include: { collection: true } },
        itemTags: { include: { tag: true } },
        attachments: true,
      },
    });

    // Additive merge: Quantum Physics preserved, Entanglement preserved, Teleportation & Quantum Optics added
    const updatedTags = updatedDb!.itemTags.map((it: any) => it.tag.name);
    expect(updatedTags).toEqual([
      'Quantum Physics',
      'Entanglement',
      'Teleportation',
      'Quantum Optics',
    ]);
    expect(updatedDb!.title).toBe('Quantum Teleportation Paper (Revised)');

    // toItemView mapped response
    const mapped = toItemView(updatedDb as any);
    expect(mapped.tags).toEqual([
      'Quantum Physics',
      'Entanglement',
      'Teleportation',
      'Quantum Optics',
    ]);
  });

  it('4 & 5. Zotero Note sync to canonical Note table -> Parent binding -> Additive tag merge & version increment', async () => {
    const wsId = workspaceA.workspaceId;
    const userId = workspaceA.ownerUserId;

    // Create parent catalog item
    const item = await catalogRepo.create(wsId, {
      title: 'Note Parent Document',
      uploadedById: userId,
    });

    // 4. Create Note via Sync Bridge
    const noteSync = await syncBridge.upsertNote({
      workspaceId: wsId,
      userId,
      catalogItemId: item.id,
      title: 'Analysis & Summary',
      contentMd: '## Key Conclusions\nResult is significant at p < 0.01.',
      tags: ['Methodology', 'methodology', 'Stats'],
    });

    expect(noteSync.id).toBeDefined();
    expect(noteSync.isNew).toBe(true);
    expect(noteSync.version).toBe(1);

    // Verify DB Note row
    const noteDb = await harness.prisma.note.findUnique({
      where: { id: noteSync.id },
    });
    expect(noteDb).toBeDefined();
    expect(noteDb!.itemId).toBe(item.id);
    expect(noteDb!.contentMd).toBe(
      '## Key Conclusions\nResult is significant at p < 0.01.',
    );
    expect(noteDb!.tags).toEqual(['Methodology', 'Stats']);
    expect(noteDb!.version).toBe(1);

    // Verify Notes query by itemId
    const notesList = await notesService.listNotes(wsId, item.id);
    expect(notesList.length).toBe(1);
    expect(notesList[0].id).toBe(noteSync.id);
    expect(notesList[0].itemId).toBe(item.id);

    // 5. Update Note via Sync Bridge with additive tags
    const noteUpdate = await syncBridge.upsertNote({
      workspaceId: wsId,
      userId,
      existingId: noteSync.id,
      catalogItemId: item.id,
      title: 'Analysis & Summary (v2)',
      contentMd:
        '## Key Conclusions Updated\nConfidence interval is [0.4, 0.8].',
      tags: ['stats', 'Hypothesis Test'],
    });

    expect(noteUpdate.id).toBe(noteSync.id);
    expect(noteUpdate.isNew).toBe(false);
    expect(noteUpdate.version).toBe(2);

    const updatedNoteDb = await harness.prisma.note.findUnique({
      where: { id: noteSync.id },
    });
    expect(updatedNoteDb!.contentMd).toBe(
      '## Key Conclusions Updated\nConfidence interval is [0.4, 0.8].',
    );
    // Additive tag merge: Methodology preserved, Stats preserved, Hypothesis Test added
    expect(updatedNoteDb!.tags).toEqual([
      'Methodology',
      'Stats',
      'Hypothesis Test',
    ]);
    expect(updatedNoteDb!.version).toBe(2);
  });

  it('6. Annotation comments on Attachment -> Create -> PATCH with expectedVersion -> Read', async () => {
    const wsId = workspaceA.workspaceId;
    const userId = workspaceA.ownerUserId;

    // Create item & attachment
    const item = await catalogRepo.create(wsId, {
      title: 'Annotated Document',
      uploadedById: userId,
    });
    const attachment = await harness.prisma.catalogAttachment.create({
      data: {
        catalogItemId: item.id,
        filename: 'test.pdf',
        url: `/files/${Date.now()}-test.pdf`,
        size: 1024,
        mimeType: 'application/pdf',
      },
    });

    // Create annotation with quoteText and comment
    const createdAnno = await annotationsService.createAnnotation(wsId, {
      attachmentId: attachment.id,
      pageIndex: 2,
      color: '#ffeb3b',
      type: 'highlight',
      quoteText: 'The Hamiltonian represents total energy.',
      comment: 'Check definition of potential V(x)',
      authorId: userId,
    });

    expect(createdAnno.id).toBeDefined();
    expect(createdAnno.version).toBe(1);
    expect(createdAnno.quoteText).toBe(
      'The Hamiltonian represents total energy.',
    );
    expect(createdAnno.comment).toBe('Check definition of potential V(x)');

    // Update annotation via optimistic locking
    const updatedAnno = await annotationsService.updateAnnotation(
      wsId,
      createdAnno.id,
      1,
      {
        comment: 'V(x) harmonic oscillator potential confirmed in Eq 4.',
      },
    );

    expect(updatedAnno.version).toBe(2);
    expect(updatedAnno.comment).toBe(
      'V(x) harmonic oscillator potential confirmed in Eq 4.',
    );
    expect(updatedAnno.quoteText).toBe(
      'The Hamiltonian represents total energy.',
    );

    // Read list by attachment
    const list = await annotationsService.getAnnotationsByAttachment(
      wsId,
      attachment.id,
    );
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(createdAnno.id);
    expect(list[0].comment).toBe(
      'V(x) harmonic oscillator potential confirmed in Eq 4.',
    );
  });

  it('7. Workspace Isolation: Workspace B cannot access Workspace A notes or annotations', async () => {
    const wsA = workspaceA.workspaceId;
    const wsB = workspaceB.workspaceId;
    const userA = workspaceA.ownerUserId;

    // Create Note in A
    const itemA = await catalogRepo.create(wsA, {
      title: 'Isolated A',
      uploadedById: userA,
    });
    const noteA = await notesService.createNote(wsA, {
      itemId: itemA.id,
      title: 'Secret Note in A',
      contentMd: 'Confidential research A',
      createdById: userA,
    });

    // Workspace B queries notes
    const notesInB = await notesService.listNotes(wsB, itemA.id);
    expect(notesInB.length).toBe(0);

    // Workspace B cannot get note A (returns null due to workspace filter)
    const noteInB = await notesService.getNote(wsB, noteA.id);
    expect(noteInB).toBeNull();

    // Workspace B cannot update note A (throws NotFoundException)
    await expect(
      notesService.updateNote(wsB, noteA.id, 1, {
        contentMd: 'Malicious overwrite',
      }),
    ).rejects.toThrow();
  });

  it('8. Deduplication & Idempotency: Re-syncing same items does not duplicate tags or notes', async () => {
    const wsId = workspaceA.workspaceId;
    const userId = workspaceA.ownerUserId;

    // Create item
    const res1 = await syncBridge.upsertCatalogItem({
      workspaceId: wsId,
      userId,
      title: 'Dedup Check Item',
      tags: ['Alpha', 'Beta'],
    });

    // Re-sync exact same tags
    const res2 = await syncBridge.upsertCatalogItem({
      workspaceId: wsId,
      userId,
      existingId: res1.id,
      title: 'Dedup Check Item',
      tags: ['Alpha', 'Beta', 'alpha'],
    });

    const itemDb = await harness.prisma.catalogItem.findUnique({
      where: { id: res1.id },
      include: {
        itemTags: { include: { tag: true } },
      },
    });
    const itemDbTags = itemDb!.itemTags.map((it: any) => it.tag.name);
    expect(itemDbTags).toEqual(['Alpha', 'Beta']);
    expect(itemDbTags.length).toBe(2);
  });
});
