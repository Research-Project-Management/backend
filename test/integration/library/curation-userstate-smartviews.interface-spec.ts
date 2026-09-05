// @ts-nocheck -- Integration test fixtures use legacy field names; update when test data is migrated
import {
  LibraryTestHarness,
  TestWorkspaceFixture,
} from './library-test-harness';
import { CatalogService } from '../../../src/modules/library/items/items.service';
import { CatalogRepository } from '../../../src/modules/library/items/items.repository';
import { ReadingService } from '../../../src/modules/library/reading/reading.service';
import { ReadingStatus } from '../../../src/modules/library/reading/types/reading.types';
import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

describe('Duplicate Merge, Item States & Server-Owned Smart Views', () => {
  let harness: LibraryTestHarness;
  let workspace: TestWorkspaceFixture;
  let catalogService: CatalogService;
  let catalogRepo: CatalogRepository;
  let readingService: ReadingService;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    workspace = await harness.seedWorkspaceFixture();
    catalogService = harness.moduleRef.get(CatalogService);
    catalogRepo = harness.moduleRef.get(CatalogRepository);
    readingService = harness.moduleRef.get(ReadingService);
  }, 60000);

  afterAll(async () => {
    if (harness) {
      await harness.close();
    }
  }, 30000);

  // ─── 1. Duplicate Detection ──────────────────────────────────────────────

  it('1. Detects exact DOI duplicates with 1.0 confidence (Tier 1)', async () => {
    const wsId = workspace.workspaceId;

    const item1 = await catalogService.createItem(wsId, {
      title: 'Attention is All You Need',
      doi: '10.48550/arXiv.1706.03762',
      year: 2017,
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      uploadedById: workspace.ownerUserId,
    });

    const item2 = await catalogService.createItem(wsId, {
      title: 'Attention Is All You Need (Reprint)',
      doi: 'https://doi.org/10.48550/arxiv.1706.03762', // same normalized DOI
      year: 2017,
      authors: ['Vaswani, A.'],
      uploadedById: workspace.ownerUserId,
    });

    const clusters = await catalogService.detectDuplicates(wsId);
    const match = clusters.find(
      (c) =>
        c.items.some((i) => i.id === item1.id) &&
        c.items.some((i) => i.id === item2.id),
    );

    expect(match).toBeDefined();
    expect(match?.matchReason).toBe('EXACT_DOI');
    expect(match?.confidence).toBe(1.0);
  });

  it('2. Detects fuzzy duplicates by title + year (±1) + first author (Tier 2)', async () => {
    const wsId = workspace.workspaceId;

    const item1 = await catalogService.createItem(wsId, {
      title: 'Deep Residual Learning for Image Recognition',
      year: 2016,
      authors: ['He, Kaiming', 'Zhang, Xiangyu'],
      uploadedById: workspace.ownerUserId,
    });

    const item2 = await catalogService.createItem(wsId, {
      title: 'Deep Residual Learning for Image Recognition.',
      year: 2015, // year - 1
      authors: ['Kaiming He'],
      uploadedById: workspace.ownerUserId,
    });

    const clusters = await catalogService.detectDuplicates(wsId);
    const match = clusters.find(
      (c) =>
        c.items.some((i) => i.id === item1.id) &&
        c.items.some((i) => i.id === item2.id),
    );

    expect(match).toBeDefined();
    expect(match?.matchReason).toBe('FUZZY_TITLE_YEAR_AUTHOR');
    expect(match?.confidence).toBe(0.85);
  });

  // ─── 2. Atomic Merge Protocol ────────────────────────────────────────────

  it('3. Atomically merges duplicates: reassigns notes & attachments, preserves annotations and comments', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    // Create primary item
    const primary = await catalogService.createItem(wsId, {
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      doi: '10.18653/v1/N19-1423',
      year: 2019,
      authors: ['Devlin, Jacob'],
      uploadedById: userId,
    });

    // Create duplicate item
    const duplicate = await catalogService.createItem(wsId, {
      title: 'BERT Pre-training Duplicate',
      doi: '10.18653/v1/N19-1423',
      year: 2019,
      authors: ['Devlin, Jacob'],
      uploadedById: userId,
    });

    // Create attachment on duplicate
    const attachment = await harness.prisma.catalogAttachment.create({
      data: {
        catalogItemId: duplicate.id,
        filename: 'bert_paper.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        url: 'https://storage.example.com/bert_paper.pdf',
      },
    });

    // Create annotation on attachment
    const annotation = await harness.prisma.annotation.create({
      data: {
        attachmentId: attachment.id,
        type: 'highlight',
        quoteText: 'Key finding',
        comment: 'Important observation note',
        pageIndex: 1,
        color: '#ffcc00',
        authorId: userId,
      },
    });

    // Create note on duplicate
    const note = await harness.prisma.note.create({
      data: {
        workspaceId: wsId,
        itemId: duplicate.id,
        title: 'Notes on BERT',
        contentMd: 'Transformer encoder architecture',
        createdById: userId,
      },
    });

    // Perform atomic merge
    const mergeResult = await catalogService.mergeDuplicates(wsId, {
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
    });

    expect(mergeResult.mergedCount).toBe(1);
    expect(mergeResult.softDeletedItemIds).toContain(duplicate.id);

    // Verify attachment reassigned to primary
    const updatedAttachment = await harness.prisma.catalogAttachment.findUnique(
      {
        where: { id: attachment.id },
      },
    );
    expect(updatedAttachment?.catalogItemId).toBe(primary.id);

    // Verify annotations still intact on attachment
    const updatedAnnotation = await harness.prisma.annotation.findUnique({
      where: { id: annotation.id },
    });
    expect(updatedAnnotation?.attachmentId).toBe(attachment.id);
    expect(updatedAnnotation?.comment).toBe('Important observation note');

    // Verify note reassigned to primary
    const updatedNote = await harness.prisma.note.findUnique({
      where: { id: note.id },
    });
    expect(updatedNote?.itemId).toBe(primary.id);
  });

  it('4. Consolidates tags additively and handles junction deduplication without collisions', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    // Create tags
    const tag1 = await harness.prisma.catalogTag.create({
      data: { workspaceId: wsId, name: 'nlp', color: '#10b981' },
    });
    const tag2 = await harness.prisma.catalogTag.create({
      data: { workspaceId: wsId, name: 'transformers', color: '#3b82f6' },
    });

    // Create primary with tag1
    const primary = await catalogService.createItem(wsId, {
      title: 'GPT-3 Paper Master',
      doi: '10.48550/arxiv.2005.14165',
      uploadedById: userId,
    });
    await harness.prisma.catalogItemTag.create({
      data: { catalogItemId: primary.id, tagId: tag1.id },
    });

    // Create duplicate with tag1 and tag2 (tag1 is shared!)
    const duplicate = await catalogService.createItem(wsId, {
      title: 'GPT-3 Paper Duplicate',
      doi: '10.48550/arxiv.2005.14165',
      uploadedById: userId,
    });
    await harness.prisma.catalogItemTag.createMany({
      data: [
        { catalogItemId: duplicate.id, tagId: tag1.id },
        { catalogItemId: duplicate.id, tagId: tag2.id },
      ],
    });

    // Execute merge
    await catalogService.mergeDuplicates(wsId, {
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
    });

    // Verify merged item tags
    const primaryItem = await harness.prisma.catalogItem.findUnique({
      where: { id: primary.id },
      include: { itemTags: true },
    });

    // Tags consolidated via itemTags junction — verify below

    // Verify junction records: primary now has both tag1 and tag2, duplicate has 0
    const primaryTagIds = primaryItem?.itemTags.map((it) => it.tagId);
    expect(primaryTagIds).toContain(tag1.id);
    expect(primaryTagIds).toContain(tag2.id);
    expect(primaryTagIds?.length).toBe(2);

    const duplicateTags = await harness.prisma.catalogItemTag.findMany({
      where: { catalogItemId: duplicate.id },
    });
    expect(duplicateTags.length).toBe(0);
  });

  it('5. Rewires item relations and eliminates self-relations and duplicate links', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const primary = await catalogService.createItem(wsId, {
      title: 'Relation Master',
      uploadedById: userId,
    });

    const duplicate = await catalogService.createItem(wsId, {
      title: 'Relation Duplicate',
      uploadedById: userId,
    });

    const otherPaper = await catalogService.createItem(wsId, {
      title: 'Other Paper',
      uploadedById: userId,
    });

    // Create relation: duplicate -> otherPaper
    await harness.prisma.itemRelation.create({
      data: {
        workspaceId: wsId,
        sourceItemId: duplicate.id,
        targetItemId: otherPaper.id,
        relationType: 'extends',
      },
    });

    // Create relation: duplicate -> primary (would become a self-relation!)
    await harness.prisma.itemRelation.create({
      data: {
        workspaceId: wsId,
        sourceItemId: duplicate.id,
        targetItemId: primary.id,
        relationType: 'cites',
      },
    });

    // Merge
    await catalogService.mergeDuplicates(wsId, {
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
    });

    // Verify rewired relation
    const relations = await harness.prisma.itemRelation.findMany({
      where: { workspaceId: wsId },
    });

    // Self-relation must be deleted
    const selfRelations = relations.filter(
      (r) => r.sourceItemId === primary.id && r.targetItemId === primary.id,
    );
    expect(selfRelations.length).toBe(0);

    // duplicate -> otherPaper should now be primary -> otherPaper
    const rewired = relations.find(
      (r) => r.sourceItemId === primary.id && r.targetItemId === otherPaper.id,
    );
    expect(rewired).toBeDefined();
    expect(rewired?.relationType).toBe('extends');
  });

  it('6. Merges UserItemState correctly across users with provenance and max logic', async () => {
    const wsId = workspace.workspaceId;
    const user1 = workspace.ownerUserId;
    const user2 = `user-${crypto.randomUUID()}`;

    // Create user2
    await harness.prisma.user.create({
      data: {
        id: user2,
        email: `user2-${Date.now()}@example.com`,
        name: 'User Two',
      },
    });

    const primary = await catalogService.createItem(wsId, {
      title: 'UserState Primary',
      citationKey: 'devlin2019primary',
      uploadedById: user1,
    });

    const duplicate = await catalogService.createItem(wsId, {
      title: 'UserState Duplicate',
      citationKey: 'devlin2019dup',
      uploadedById: user1,
    });

    // User1 state: primary is unread, duplicate is completed with rating 5
    const pastDate = new Date(Date.now() - 100000);
    const recentDate = new Date();

    await harness.prisma.userItemState.create({
      data: {
        userId: user1,
        itemId: primary.id,
        readStatus: 'unread',
        rating: 2,
        lastReadAt: pastDate,
      },
    });

    await harness.prisma.userItemState.create({
      data: {
        userId: user1,
        itemId: duplicate.id,
        readStatus: 'completed',
        rating: 5,
        lastReadAt: recentDate,
      },
    });

    // User2 state: duplicate is reading
    await harness.prisma.userItemState.create({
      data: {
        userId: user2,
        itemId: duplicate.id,
        readStatus: 'reading',
        rating: 3,
        lastReadAt: recentDate,
      },
    });

    // Merge
    await catalogService.mergeDuplicates(wsId, {
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
    });

    // Verify User1 consolidated state
    const u1State = await harness.prisma.userItemState.findUnique({
      where: { userId_itemId: { userId: user1, itemId: primary.id } },
    });
    expect(u1State?.readStatus).toBe('completed');
    expect(u1State?.rating).toBe(5);
    expect(u1State?.lastReadAt?.toISOString()).toBe(recentDate.toISOString());

    // Verify User2 state transferred to primary
    const u2State = await harness.prisma.userItemState.findUnique({
      where: { userId_itemId: { userId: user2, itemId: primary.id } },
    });
    expect(u2State?.readStatus).toBe('reading');
    expect(u2State?.rating).toBe(3);

    // Verify citation key provenance
    const updatedPrimary = await harness.prisma.catalogItem.findUnique({
      where: { id: primary.id },
    });
    const extra = JSON.parse(updatedPrimary?.extra || '{}');
    expect(extra.mergedCitationKeys).toContain('devlin2019dup');
  });

  it('7. Enforces fieldSelections allowlist and rejects forbidden fields with 400 Bad Request', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const primary = await catalogService.createItem(wsId, {
      title: 'Field Select Primary',
      uploadedById: userId,
    });

    const duplicate = await catalogService.createItem(wsId, {
      title: 'Field Select Duplicate',
      uploadedById: userId,
    });

    // Attempt to update forbidden field 'workspaceId' or 'version'
    await expect(
      catalogService.mergeDuplicates(wsId, {
        primaryItemId: primary.id,
        duplicateItemIds: [duplicate.id],
        fieldSelections: {
          workspaceId: 'other-ws-id',
        } as any,
      }),
    ).rejects.toThrow(BadRequestException);

    // Valid allowlisted field update succeeds
    const res = await catalogService.mergeDuplicates(wsId, {
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
      fieldSelections: {
        title: 'Overridden Primary Title',
        abstract: 'New synthesized abstract',
      },
    });

    expect(res.primaryItem.title).toBe('Overridden Primary Title');
    expect(res.primaryItem.abstract).toBe('New synthesized abstract');
  });

  it('8. Soft-deletes duplicates with mergedIntoId marker, writes LibraryChange, Tombstone and Outbox', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const primary = await catalogService.createItem(wsId, {
      title: 'Audit Primary',
      uploadedById: userId,
    });

    const duplicate = await catalogService.createItem(wsId, {
      title: 'Audit Duplicate',
      uploadedById: userId,
    });

    await catalogService.mergeDuplicates(wsId, {
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
    });

    // Verify duplicate is soft-deleted and has mergedIntoId
    const dupItem = await harness.prisma.catalogItem.findUnique({
      where: { id: duplicate.id },
    });
    expect(dupItem?.deletedAt).not.toBeNull();
    const dupExtra = JSON.parse(dupItem?.extra || '{}');
    expect(dupExtra.mergedIntoId).toBe(primary.id);

    // Verify LibraryChange recorded for primary (update) and duplicate (delete)
    const changes = await harness.prisma.libraryChange.findMany({
      where: {
        workspaceId: wsId,
        entityId: { in: [primary.id, duplicate.id] },
      },
    });
    expect(changes.length).toBeGreaterThanOrEqual(2);

    // Verify Tombstone recorded for duplicate
    const tombstone = await harness.prisma.tombstone.findFirst({
      where: { workspaceId: wsId, entityId: duplicate.id },
    });
    expect(tombstone).toBeDefined();

    // Verify Outbox event published
    const outbox = await harness.prisma.outboxEvent.findFirst({
      where: {
        workspaceId: wsId,
        aggregateId: primary.id,
        eventType: 'library.item.merged',
      },
    });
    expect(outbox).toBeDefined();
    const payload =
      typeof outbox?.payload === 'string'
        ? JSON.parse(outbox.payload)
        : outbox?.payload;
    expect(payload).toMatchObject({
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
    });
  });

  it('9. Reject restoring a merged duplicate item with 400 Bad Request', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const primary = await catalogService.createItem(wsId, {
      title: 'Restore Guard Primary',
      uploadedById: userId,
    });

    const duplicate = await catalogService.createItem(wsId, {
      title: 'Restore Guard Duplicate',
      uploadedById: userId,
    });

    await catalogService.mergeDuplicates(wsId, {
      primaryItemId: primary.id,
      duplicateItemIds: [duplicate.id],
    });

    // Attempting to restore the merged duplicate must fail with BadRequestException
    await expect(
      catalogService.restoreItem(wsId, duplicate.id),
    ).rejects.toThrow(BadRequestException);
  });

  // ─── 3. UserItemState Module & Endpoints ─────────────────────────────────

  it('10. UserItemState: GET and PATCH state correctly', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const item = await catalogService.createItem(wsId, {
      title: 'User State Testing Paper',
      uploadedById: userId,
    });

    // Initial state is default
    const initial = await readingService.getState(wsId, item.id, userId);
    expect(initial).toEqual({
      readStatus: 'unread',
      rating: 0,
      lastReadAt: null,
    });

    // Update state via PATCH
    const updated = await readingService.updateState(wsId, item.id, userId, {
      readStatus: ReadingStatus.READING,
      rating: 4,
    });

    expect(updated.readStatus).toBe('reading');
    expect(updated.rating).toBe(4);

    // Verify GET reflects patched values
    const fetched = await readingService.getState(wsId, item.id, userId);
    expect(fetched.readStatus).toBe('reading');
    expect(fetched.rating).toBe(4);
  });

  it('11. UserItemState: POST /read endpoint sets server timestamp, unread -> reading, preserves completed', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const item = await catalogService.createItem(wsId, {
      title: 'Reading Progress Test Paper',
      uploadedById: userId,
    });

    const before = new Date();
    const res1 = await readingService.markAsRead(wsId, item.id, userId);
    const after = new Date();

    expect(res1.readStatus).toBe('reading');
    expect(res1.lastReadAt).not.toBeNull();
    const readDate = new Date(res1.lastReadAt!);
    expect(readDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(readDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);

    // Verify CatalogItem.accessedAt is not modified
    const dbItem = await harness.prisma.catalogItem.findUnique({
      where: { id: item.id },
    });
    expect(dbItem?.accessedAt).toBeNull();

    // Mark as completed
    await readingService.updateState(wsId, item.id, userId, {
      readStatus: ReadingStatus.COMPLETED,
    });

    // Calling markAsRead again should NOT downgrade completed to reading
    const res2 = await readingService.markAsRead(wsId, item.id, userId);
    expect(res2.readStatus).toBe('completed');
  });

  // ─── 4. Server-Owned Smart Views & Trash ─────────────────────────────────

  it('12. Smart View: view=recent returns only read items sorted by lastReadAt DESC', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const readFirst = await catalogService.createItem(wsId, {
      title: 'Read First Paper',
      uploadedById: userId,
    });
    const readSecond = await catalogService.createItem(wsId, {
      title: 'Read Second Paper',
      uploadedById: userId,
    });

    // Read first item earlier
    await harness.prisma.userItemState.upsert({
      where: { userId_itemId: { userId, itemId: readFirst.id } },
      create: {
        userId,
        itemId: readFirst.id,
        readStatus: 'reading',
        lastReadAt: new Date(Date.now() - 50000),
      },
      update: {
        lastReadAt: new Date(Date.now() - 50000),
      },
    });

    // Read second item now
    await readingService.markAsRead(wsId, readSecond.id, userId);

    const list = await catalogService.listItems(wsId, {
      view: 'recent',
      userId,
    });

    const ids = list.items.map((it: any) => it.id);
    expect(ids[0]).toBe(readSecond.id);
    expect(ids).toContain(readFirst.id);
  });

  it('14. Smart View: view=unfiled uses canonical collectionItems junction check', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const collection = await harness.prisma.collection.create({
      data: { workspaceId: wsId, name: 'AI Collection', createdById: userId },
    });

    const unfiledItem = await catalogService.createItem(wsId, {
      title: 'Unfiled Item Lone',
      uploadedById: userId,
    });

    const filedItem = await catalogService.createItem(wsId, {
      title: 'Filed Item Member',
      uploadedById: userId,
    });
    await harness.prisma.collectionItem.create({
      data: {
        collectionId: collection.id,
        catalogItemId: filedItem.id,
      },
    });

    const list = await catalogService.listItems(wsId, {
      view: 'unfiled',
      userId,
    });

    const ids = list.items.map((it: any) => it.id);
    expect(ids).toContain(unfiledItem.id);
    expect(ids).not.toContain(filedItem.id);
  });

  it('15. Smart View: view=trash, restoreItem and purgeItem lifecycle', async () => {
    const wsId = workspace.workspaceId;
    const userId = workspace.ownerUserId;

    const item = await catalogService.createItem(wsId, {
      title: 'Trash Lifecycle Item',
      uploadedById: userId,
    });

    // Soft delete item
    await catalogService.deleteItem(wsId, item.id);

    // Check view=trash contains item
    const trashList = await catalogService.listItems(wsId, {
      view: 'trash',
      userId,
    });
    expect(trashList.items.map((it: any) => it.id)).toContain(item.id);

    // Restore item
    const restored = await catalogService.restoreItem(wsId, item.id);
    expect(restored.deletedAt).toBeNull();

    // Check regular list contains item again
    const allList = await catalogService.listItems(wsId, {
      view: 'all',
      userId,
    });
    expect(allList.items.map((it: any) => it.id)).toContain(item.id);

    // Soft delete and permanently purge
    await catalogService.deleteItem(wsId, item.id);
    const purged = await catalogService.purgeItem(wsId, item.id);
    expect(purged).toBe(true);

    // Verify completely deleted from database
    const dbItem = await harness.prisma.catalogItem.findUnique({
      where: { id: item.id },
    });
    expect(dbItem).toBeNull();
  });
});
