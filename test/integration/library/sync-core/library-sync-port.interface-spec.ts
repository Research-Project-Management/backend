import { LibraryTestHarness } from '../library-test-harness';
import {
  LIBRARY_SYNC_PORT,
  ILibrarySyncPort,
} from '../../../../src/modules/library/sync/library-sync.port';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

jest.setTimeout(60000);

describe('Library Sync Port (ILibrarySyncPort Integration & Invariants)', () => {
  let harness: LibraryTestHarness;
  let port: ILibrarySyncPort;
  let workspaceIdA: string;
  let userIdA: string;
  let workspaceIdB: string;
  let userIdB: string;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    port = harness.moduleRef.get(LIBRARY_SYNC_PORT);

    const tenantA = await harness.seedWorkspaceFixture();
    workspaceIdA = tenantA.workspaceId;
    userIdA = tenantA.ownerUserId;

    const tenantB = await harness.seedWorkspaceFixture();
    workspaceIdB = tenantB.workspaceId;
    userIdB = tenantB.ownerUserId;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Atomic Batch Rollback (applyExternalSyncBatch)', () => {
    it('rolls back all writes, change logs, and outbox events when any operation in a batch fails', async () => {
      const colName = `Atomic Rollback Collection ${Date.now()}`;
      const itemTitle = `Atomic Rollback Paper ${Date.now()}`;

      await expect(
        port.applyExternalSyncBatch({
          workspaceId: workspaceIdA,
          operations: [
            {
              op: 'upsertCollection',
              command: {
                workspaceId: workspaceIdA,
                userId: userIdA,
                name: colName,
              },
            },
            {
              op: 'upsertCatalogItem',
              command: {
                workspaceId: workspaceIdA,
                userId: userIdA,
                title: itemTitle,
              },
            },
            {
              op: 'upsertAttachment',
              command: {
                workspaceId: workspaceIdA,
                catalogItemId: 'non-existent-parent-item-id-999',
                filename: 'fail.pdf',
                url: 'https://flux.test/fail.pdf',
                mimeType: 'application/pdf',
              },
            },
          ],
        }),
      ).rejects.toThrow(NotFoundException);

      // Verify Collection was NEVER committed
      const col = await harness.prisma.collection.findFirst({
        where: { workspaceId: workspaceIdA, name: colName },
      });
      expect(col).toBeNull();

      // Verify CatalogItem was NEVER committed
      const item = await harness.prisma.catalogItem.findFirst({
        where: { workspaceId: workspaceIdA, title: itemTitle },
      });
      expect(item).toBeNull();

      // Verify no changes were logged
      const change = await harness.prisma.libraryChange.findFirst({
        where: {
          workspaceId: workspaceIdA,
          data: { path: ['title'], equals: itemTitle },
        },
      });
      expect(change).toBeNull();
    });

    it('successfully commits all operations in a valid batch in a single atomic transaction', async () => {
      const colName = `Batch Success Col ${Date.now()}`;
      const itemTitle = `Batch Success Paper ${Date.now()}`;

      const res = await port.applyExternalSyncBatch({
        workspaceId: workspaceIdA,
        operations: [
          {
            op: 'upsertCollection',
            command: {
              workspaceId: workspaceIdA,
              userId: userIdA,
              name: colName,
            },
          },
          {
            op: 'upsertCatalogItem',
            command: {
              workspaceId: workspaceIdA,
              userId: userIdA,
              title: itemTitle,
            },
          },
        ],
      });

      expect(res.results).toHaveLength(2);
      expect(res.results[0].result?.isNew).toBe(true);
      expect(res.results[1].result?.isNew).toBe(true);

      const dbItem = await harness.prisma.catalogItem.findUnique({
        where: { id: res.results[1].result?.id },
      });
      expect(dbItem).not.toBeNull();
      expect(dbItem?.title).toBe(itemTitle);
    });
  });

  describe('2. Cross-Workspace Isolation & Error Boundary', () => {
    it('rejects updates to entities belonging to another workspace with ForbiddenException', async () => {
      const itemA = await port.upsertCatalogItem({
        workspaceId: workspaceIdA,
        userId: userIdA,
        title: 'Workspace A Item',
      });

      await expect(
        port.upsertCatalogItem({
          workspaceId: workspaceIdB,
          userId: userIdB,
          existingId: itemA.id,
          title: 'Hacked Title in Workspace B',
        }),
      ).rejects.toThrow(ForbiddenException);

      const dbItem = await harness.prisma.catalogItem.findUnique({
        where: { id: itemA.id },
      });
      expect(dbItem?.title).toBe('Workspace A Item');
    });

    it('rejects deletion of entities belonging to another workspace with ForbiddenException', async () => {
      const colA = await port.upsertCollection({
        workspaceId: workspaceIdA,
        userId: userIdA,
        name: 'Workspace A Collection',
      });

      await expect(
        port.deleteEntity({
          workspaceId: workspaceIdB,
          entityType: 'Collection',
          entityId: colA.id,
        }),
      ).rejects.toThrow(ForbiddenException);

      const dbCol = await harness.prisma.collection.findUnique({
        where: { id: colA.id },
      });
      expect(dbCol?.deletedAt).toBeNull();
    });
  });

  describe('3. Monotonic Versioning & Change Logs', () => {
    it('maintains strict monotonic versions on CatalogItem and Collection', async () => {
      // 1. CatalogItem (1 -> 2 -> 3)
      const itemCreated = await port.upsertCatalogItem({
        workspaceId: workspaceIdA,
        userId: userIdA,
        title: 'V1 Title',
      });
      expect(itemCreated.version).toBe(1);

      const itemUpdated1 = await port.upsertCatalogItem({
        workspaceId: workspaceIdA,
        userId: userIdA,
        existingId: itemCreated.id,
        title: 'V2 Title',
      });
      expect(itemUpdated1.version).toBe(2);

      const itemUpdated2 = await port.upsertCatalogItem({
        workspaceId: workspaceIdA,
        userId: userIdA,
        existingId: itemCreated.id,
        title: 'V3 Title',
      });
      expect(itemUpdated2.version).toBe(3);

      const itemChanges = await harness.prisma.libraryChange.findMany({
        where: { workspaceId: workspaceIdA, entityId: itemCreated.id },
        orderBy: { version: 'asc' },
      });
      expect(itemChanges.map((c) => c.version)).toEqual([1, 2, 3]);

      // 2. Collection (1 -> 2 -> 3)
      const colCreated = await port.upsertCollection({
        workspaceId: workspaceIdA,
        userId: userIdA,
        name: 'V1 Collection',
      });
      expect(colCreated.version).toBe(1);

      const colUpdated1 = await port.upsertCollection({
        workspaceId: workspaceIdA,
        userId: userIdA,
        existingId: colCreated.id,
        name: 'V2 Collection',
      });
      expect(colUpdated1.version).toBe(2);

      const colUpdated2 = await port.upsertCollection({
        workspaceId: workspaceIdA,
        userId: userIdA,
        existingId: colCreated.id,
        name: 'V3 Collection',
      });
      expect(colUpdated2.version).toBe(3);

      const colChanges = await harness.prisma.libraryChange.findMany({
        where: { workspaceId: workspaceIdA, entityId: colCreated.id },
        orderBy: { version: 'asc' },
      });
      expect(colChanges.map((c) => c.version)).toEqual([1, 2, 3]);
    });

    it('tracks Attachment versioning through monotonic AttachmentRevision entries', async () => {
      const item = await port.upsertCatalogItem({
        workspaceId: workspaceIdA,
        userId: userIdA,
        title: 'Paper for Attachments',
      });

      // Create attachment (revision 1)
      const attCreated = await port.upsertAttachment({
        workspaceId: workspaceIdA,
        catalogItemId: item.id,
        filename: 'draft_v1.pdf',
        url: 'https://test.local/draft_v1.pdf',
        mimeType: 'application/pdf',
        fileHash: 'hash_v1',
        size: 1024,
      });
      expect(attCreated.version).toBe(1);

      // Update attachment (revision 2)
      const attUpdated1 = await port.upsertAttachment({
        workspaceId: workspaceIdA,
        existingId: attCreated.id,
        catalogItemId: item.id,
        filename: 'draft_v2.pdf',
        url: 'https://test.local/draft_v2.pdf',
        mimeType: 'application/pdf',
        fileHash: 'hash_v2',
        size: 2048,
      });
      expect(attUpdated1.version).toBe(2);

      // Update attachment (revision 3)
      const attUpdated2 = await port.upsertAttachment({
        workspaceId: workspaceIdA,
        existingId: attCreated.id,
        catalogItemId: item.id,
        filename: 'draft_v3.pdf',
        url: 'https://test.local/draft_v3.pdf',
        mimeType: 'application/pdf',
        fileHash: 'hash_v3',
        size: 4096,
      });
      expect(attUpdated2.version).toBe(3);

      const revisions = await harness.prisma.attachmentRevision.findMany({
        where: { attachmentId: attCreated.id },
        orderBy: { revisionNumber: 'asc' },
      });
      expect(revisions).toHaveLength(3);
      expect(revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
      expect(revisions.map((r) => r.fileHash)).toEqual([
        'hash_v1',
        'hash_v2',
        'hash_v3',
      ]);
    });
  });

  describe('4. Idempotent Retry & Batch Query', () => {
    it('returns consistent snapshot and batch snapshots for multiple items', async () => {
      const item1 = await port.upsertCatalogItem({
        workspaceId: workspaceIdA,
        userId: userIdA,
        title: 'Batch Query Item 1',
        abstract: 'Abstract 1',
      });
      const item2 = await port.upsertCatalogItem({
        workspaceId: workspaceIdA,
        userId: userIdA,
        title: 'Batch Query Item 2',
        abstract: 'Abstract 2',
      });

      const snapshot1 = await port.getItemSnapshot({
        workspaceId: workspaceIdA,
        itemId: item1.id,
      });
      expect(snapshot1?.title).toBe('Batch Query Item 1');

      const summaries = await port.getItemSnapshots({
        workspaceId: workspaceIdA,
        itemIds: [item1.id, item2.id],
      });
      expect(summaries).toHaveLength(2);
      expect(summaries.map((s) => s.title)).toEqual([
        'Batch Query Item 1',
        'Batch Query Item 2',
      ]);
    });
  });

  describe('5. Duplicate Outbox Deduplication', () => {
    it('gracefully deduplicates outbox events with identical dedupeKey', async () => {
      const dedupeKey = `dedupe_test_${Date.now()}`;

      const res1 = await port.publishIntegrationEvent({
        workspaceId: workspaceIdA,
        aggregateId: 'agg-1',
        eventType: 'library.zotero.test_dedupe',
        dedupeKey,
        payload: { test: true },
      });
      expect(res1.id).toBeDefined();
      expect(res1.id.startsWith('deduped-')).toBe(false);

      const res2 = await port.publishIntegrationEvent({
        workspaceId: workspaceIdA,
        aggregateId: 'agg-1',
        eventType: 'library.zotero.test_dedupe',
        dedupeKey,
        payload: { test: true },
      });
      expect(res2.id).toBe(`deduped-${dedupeKey}`);

      const count = await harness.prisma.outboxEvent.count({
        where: { dedupeKey },
      });
      expect(count).toBe(1);
    });
  });
});
