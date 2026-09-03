// @ts-nocheck -- Integration test fixtures use legacy field names; update when test data is migrated
import { LibraryTestHarness } from '../library-test-harness';
import { TransactionService } from '../../../../src/modules/library/sync/services/transaction.service';

describe('Atomic Write & Outbox Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let txService: TransactionService;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    txService = harness.moduleRef.get(TransactionService);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Atomic Mutation + ChangeLog + Outbox Commit', () => {
    it('commits aggregate modification, change log entry, and outbox event in a single atomic transaction and verifies via DB query', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      const executedTx = await txService.executeInTransaction(
        async (tx, helpers) => {
          const item = await tx.catalogItem.create({
            data: {
              workspaceId: tenant.workspaceId,
              uploadedById: tenant.ownerUserId,
              title: 'Quantum Attention Networks',
              version: 1,
            },
          });

          const changeLog = await helpers.appendChange(tenant.workspaceId, {
            entityType: 'CatalogItem',
            entityId: item.id,
            action: 'create',
            version: 1,
            data: { title: item.title },
          });

          const outbox = await helpers.publishOutbox(
            tenant.workspaceId,
            item.id,
            'library.item.created',
            { itemId: item.id, version: 1 },
          );

          return { item, changeLog, outbox };
        },
      );

      // Verify returned objects
      expect(executedTx.item.title).toBe('Quantum Attention Networks');
      expect(Number(executedTx.changeLog.seq)).toBeGreaterThan(0);
      expect(executedTx.outbox.status).toBe('PENDING');

      // Verify directly from real PostgreSQL database
      const dbItem = await harness.prisma.catalogItem.findUnique({
        where: { id: executedTx.item.id },
      });
      expect(dbItem).not.toBeNull();
      expect(dbItem?.title).toBe('Quantum Attention Networks');

      const dbChange = await harness.prisma.libraryChange.findFirst({
        where: {
          workspaceId: tenant.workspaceId,
          entityId: executedTx.item.id,
        },
      });
      expect(dbChange).not.toBeNull();
      expect(Number(dbChange?.seq)).toBe(Number(executedTx.changeLog.seq));

      const dbOutbox = await harness.prisma.outboxEvent.findFirst({
        where: {
          workspaceId: tenant.workspaceId,
          aggregateId: executedTx.item.id,
        },
      });
      expect(dbOutbox).not.toBeNull();
      expect(dbOutbox?.eventType).toBe('library.item.created');
    });
  });

  describe('2. Transaction Rollback Invariant', () => {
    it('rolls back entity mutation and emits zero change logs or outbox events on transaction error', async () => {
      const tenant = await harness.seedWorkspaceFixture();
      let attemptedItemId = '';

      let txError: Error | null = null;
      try {
        await txService.executeInTransaction(async (tx, helpers) => {
          const item = await tx.catalogItem.create({
            data: {
              workspaceId: tenant.workspaceId,
              uploadedById: tenant.ownerUserId,
              title: 'Should Be Rolled Back',
              version: 1,
            },
          });
          attemptedItemId = item.id;

          await helpers.appendChange(tenant.workspaceId, {
            entityType: 'CatalogItem',
            entityId: item.id,
            action: 'create',
            version: 1,
          });

          await helpers.publishOutbox(
            tenant.workspaceId,
            item.id,
            'library.item.created',
            { itemId: item.id },
          );

          throw new Error('Simulated database constraint failure during write');
        });
      } catch (err: any) {
        txError = err;
      }

      expect(txError).not.toBeNull();
      expect(txError?.message).toContain(
        'Simulated database constraint failure',
      );

      // Verify ZERO rows committed to PostgreSQL database
      const dbItem = await harness.prisma.catalogItem.findUnique({
        where: { id: attemptedItemId },
      });
      expect(dbItem).toBeNull();

      const dbChanges = await harness.prisma.libraryChange.findMany({
        where: { workspaceId: tenant.workspaceId },
      });
      expect(dbChanges).toHaveLength(0);

      const dbOutbox = await harness.prisma.outboxEvent.findMany({
        where: { workspaceId: tenant.workspaceId },
      });
      expect(dbOutbox).toHaveLength(0);
    });
  });
});
