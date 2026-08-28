import { LibraryTestHarness } from '../library-test-harness';
import {
  LIBRARY_SYNC_PORT,
  ILibrarySyncPort,
} from '../../../../src/modules/library/library-sync.port';
import { ConflictException, NotFoundException } from '@nestjs/common';

jest.setTimeout(60000);

describe('Concurrent Idempotency & Reliability Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let port: ILibrarySyncPort;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    port = harness.moduleRef.get(LIBRARY_SYNC_PORT);
  });

  afterAll(async () => {
    await harness.close();
  });

  // ── 1. Concurrent claim: only one winner executes canonical writes ────────
  describe('1. Concurrent Idempotency — one winner, one cache hit', () => {
    it('Promise.all with identical idempotency key creates exactly one canonical entity', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const key = `concurrent-idempotency-${Date.now()}-${Math.random()}`;
      const title = `Concurrent Paper ${key}`;

      const batchCommand = {
        workspaceId: tenant.workspaceId,
        idempotencyKey: key,
        operations: [
          {
            op: 'upsertCatalogItem' as const,
            operationId: 'item:concurrent',
            command: {
              workspaceId: tenant.workspaceId,
              userId: tenant.ownerUserId,
              title,
            },
          },
        ],
      };

      const [res1, res2] = await Promise.all([
        port.applyExternalSyncBatch(batchCommand),
        port.applyExternalSyncBatch(batchCommand),
      ]);

      expect(res1.results[0].result?.id).toBeDefined();
      expect(res1.results[0].result?.id).toBe(res2.results[0].result?.id);

      const count = await harness.prisma.catalogItem.count({
        where: { workspaceId: tenant.workspaceId, title },
      });
      expect(count).toBe(1);
    });
  });

  // ── 2. Hash mismatch → ConflictException ─────────────────────────────────
  describe('2. Hash Mismatch — ConflictException', () => {
    it('throws ConflictException when same idempotency key is reused with a different payload', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const key = `hash-mismatch-${Date.now()}-${Math.random()}`;

      await port.applyExternalSyncBatch({
        workspaceId: tenant.workspaceId,
        idempotencyKey: key,
        operations: [
          {
            op: 'upsertCatalogItem' as const,
            command: {
              workspaceId: tenant.workspaceId,
              userId: tenant.ownerUserId,
              title: 'Original Title',
            },
          },
        ],
      });

      await expect(
        port.applyExternalSyncBatch({
          workspaceId: tenant.workspaceId,
          idempotencyKey: key,
          operations: [
            {
              op: 'upsertCatalogItem' as const,
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                title: 'DIFFERENT Title — should conflict',
              },
            },
          ],
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ── 3. Stale in_progress record with different hash → ConflictException ───
  describe('3. Rollback Recovery — stale in_progress with different hash', () => {
    it('detects hash mismatch on stale in_progress record', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const key = `stale-in-progress-${Date.now()}-${Math.random()}`;

      await harness.prisma.idempotencyRecord.create({
        data: {
          workspaceId: tenant.workspaceId,
          idempotencyKey: key,
          requestHash: 'stale-placeholder-hash',
          status: 'in_progress',
          expiresAt: new Date(Date.now() - 1000),
        },
      });

      await expect(
        port.applyExternalSyncBatch({
          workspaceId: tenant.workspaceId,
          idempotencyKey: key,
          operations: [
            {
              op: 'upsertCatalogItem' as const,
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                title: `Stale Retry Paper ${key}`,
              },
            },
          ],
        }),
      ).rejects.toThrow(ConflictException);

      await harness.prisma.idempotencyRecord.deleteMany({
        where: { workspaceId: tenant.workspaceId, idempotencyKey: key },
      });
    });

    it('second identical call returns cached result, not a new entity', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const key = `retry-cache-${Date.now()}-${Math.random()}`;
      const title = `Retry Cache Paper ${key}`;

      const batchCommand = {
        workspaceId: tenant.workspaceId,
        idempotencyKey: key,
        operations: [
          {
            op: 'upsertCatalogItem' as const,
            command: {
              workspaceId: tenant.workspaceId,
              userId: tenant.ownerUserId,
              title,
            },
          },
        ],
      };

      const first = await port.applyExternalSyncBatch(batchCommand);
      const cached = await port.applyExternalSyncBatch(batchCommand);

      expect(cached.results[0].result?.id).toBe(first.results[0].result?.id);
      const count = await harness.prisma.catalogItem.count({
        where: { workspaceId: tenant.workspaceId, title },
      });
      expect(count).toBe(1);
    });
  });

  // ── 4. Missing parentRef → NotFoundException + full rollback ─────────────
  describe('4. Parent Reference Safety — missing parentRef rolls back batch', () => {
    it('throws NotFoundException and rolls back all writes when note parentRef is unresolvable', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const itemTitle = `Parent Safety Item ${Date.now()}`;
      const noteTitle = `Orphan Note ${Date.now()}`;

      await expect(
        port.applyExternalSyncBatch({
          workspaceId: tenant.workspaceId,
          operations: [
            {
              op: 'upsertCatalogItem' as const,
              operationId: 'item:1',
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                title: itemTitle,
              },
            },
            {
              op: 'upsertNote' as const,
              operationId: 'note:1',
              parentRef: 'item:NON_EXISTENT',
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                title: noteTitle,
                contentMd: '## Orphan',
              },
            },
          ],
        }),
      ).rejects.toThrow(NotFoundException);

      const item = await harness.prisma.catalogItem.findFirst({
        where: { workspaceId: tenant.workspaceId, title: itemTitle },
      });
      expect(item).toBeNull();

      const note = await harness.prisma.note.findFirst({
        where: { workspaceId: tenant.workspaceId, title: noteTitle },
      });
      expect(note).toBeNull();
    });

    it('throws NotFoundException when attachment parentRef cannot be resolved', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      await expect(
        port.applyExternalSyncBatch({
          workspaceId: tenant.workspaceId,
          operations: [
            {
              op: 'upsertAttachment' as const,
              operationId: 'att:1',
              parentRef: 'item:GHOST',
              command: {
                workspaceId: tenant.workspaceId,
                filename: 'ghost.pdf',
                url: 'https://example.com/ghost.pdf',
                mimeType: 'application/pdf',
              },
            },
          ],
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── 5. Child-before-parent → topological sort corrects order ─────────────
  describe('5. Topological Sort — child-before-parent succeeds after sorting', () => {
    it('creates parent and child collections correctly when child appears before parent in batch', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const ts = Date.now();

      const result = await port.applyExternalSyncBatch({
        workspaceId: tenant.workspaceId,
        operations: [
          {
            op: 'upsertCollection' as const,
            operationId: 'col:child',
            parentRef: 'col:parent',
            command: {
              workspaceId: tenant.workspaceId,
              userId: tenant.ownerUserId,
              name: `Child Collection ${ts}`,
            },
          },
          {
            op: 'upsertCollection' as const,
            operationId: 'col:parent',
            command: {
              workspaceId: tenant.workspaceId,
              userId: tenant.ownerUserId,
              name: `Parent Collection ${ts}`,
            },
          },
        ],
      });

      expect(result.results).toHaveLength(2);

      const parentResult = result.results.find((r) => r.operationId === 'col:parent');
      const childResult = result.results.find((r) => r.operationId === 'col:child');

      expect(parentResult?.result?.isNew).toBe(true);
      expect(childResult?.result?.isNew).toBe(true);

      const childDb = await harness.prisma.collection.findUnique({
        where: { id: childResult!.result!.id },
      });
      expect(childDb?.parentId).toBe(parentResult!.result!.id);
    });
  });

  // ── 6. Circular hierarchy → ConflictException before any writes ───────────
  describe('6. Cycle Detection — circular collection hierarchy rejected', () => {
    it('throws ConflictException for A→B→C→A cycle and writes nothing', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const ts = Date.now();

      await expect(
        port.applyExternalSyncBatch({
          workspaceId: tenant.workspaceId,
          operations: [
            {
              op: 'upsertCollection' as const,
              operationId: 'col:A',
              parentRef: 'col:C',
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                name: `Cyclic A ${ts}`,
              },
            },
            {
              op: 'upsertCollection' as const,
              operationId: 'col:B',
              parentRef: 'col:A',
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                name: `Cyclic B ${ts}`,
              },
            },
            {
              op: 'upsertCollection' as const,
              operationId: 'col:C',
              parentRef: 'col:B',
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                name: `Cyclic C ${ts}`,
              },
            },
          ],
        }),
      ).rejects.toThrow(ConflictException);

      const count = await harness.prisma.collection.count({
        where: {
          workspaceId: tenant.workspaceId,
          name: { contains: `Cyclic` },
        },
      });
      expect(count).toBe(0);
    });
  });

  // ── 7. Note without parent → NotFoundException (not standalone) ───────────
  describe('7. Note Parent Safety — note with unresolvable parentRef is rejected', () => {
    it('throws NotFoundException and does not create standalone note', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const noteTitle = `Standalone Note Attempt ${Date.now()}`;

      await expect(
        port.applyExternalSyncBatch({
          workspaceId: tenant.workspaceId,
          operations: [
            {
              op: 'upsertNote' as const,
              operationId: 'note:orphan',
              parentRef: 'item:DOES_NOT_EXIST',
              command: {
                workspaceId: tenant.workspaceId,
                userId: tenant.ownerUserId,
                title: noteTitle,
                contentMd: '## Should not exist',
              },
            },
          ],
        }),
      ).rejects.toThrow(NotFoundException);

      const note = await harness.prisma.note.findFirst({
        where: { workspaceId: tenant.workspaceId, title: noteTitle },
      });
      expect(note).toBeNull();
    });
  });

  // ── 8. Deterministic hash — retry with existingId still hits cache ─────────
  describe('8. Deterministic Hash — retry after existingId is set returns cached result', () => {
    it('returns cached batch result on retry even when existingId differs (excluded from hash)', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      const key = `deterministic-hash-retry-${Date.now()}-${Math.random()}`;
      const title = `Deterministic Hash Paper ${key}`;

      const firstResult = await port.applyExternalSyncBatch({
        workspaceId: tenant.workspaceId,
        idempotencyKey: key,
        operations: [
          {
            op: 'upsertCatalogItem' as const,
            operationId: 'item:1',
            command: {
              workspaceId: tenant.workspaceId,
              userId: tenant.ownerUserId,
              title,
            },
          },
        ],
      });

      expect(firstResult.results[0].result?.isNew).toBe(true);
      const createdId = firstResult.results[0].result?.id!;

      // Retry with existingId set (simulates Zotero worker retry after bindings recorded)
      const retryResult = await port.applyExternalSyncBatch({
        workspaceId: tenant.workspaceId,
        idempotencyKey: key,
        operations: [
          {
            op: 'upsertCatalogItem' as const,
            operationId: 'item:1',
            command: {
              workspaceId: tenant.workspaceId,
              userId: tenant.ownerUserId,
              title,
              existingId: createdId,
            },
          },
        ],
      });

      expect(retryResult.results[0].result?.id).toBe(createdId);

      const count = await harness.prisma.catalogItem.count({
        where: { workspaceId: tenant.workspaceId, title },
      });
      expect(count).toBe(1);
    });
  });
});
