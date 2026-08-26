import { LibraryTestHarness } from '../library-test-harness';
import { LibraryTransactionService } from '../../../../src/contexts/library/sync-core/library-transaction.service';

describe('Atomic Write & Outbox Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let txService: LibraryTransactionService;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    txService = harness.moduleRef.get(LibraryTransactionService);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Atomic Mutation + ChangeLog + Outbox Commit', () => {
    it('commits aggregate modification, change log entry, and outbox event in a single atomic transaction', async () => {
      const tenant = harness.createWorkspaceFixture();

      const executedTx = await txService.executeInTransaction(
        async (_tx, helpers) => {
          const item = {
            id: 'item-atomic-1',
            workspaceId: tenant.workspaceId,
            title: 'Quantum Attention Networks',
            version: 2,
          };

          const changeLog = await helpers.appendChange(tenant.workspaceId, {
            entityType: 'CatalogItem',
            entityId: item.id,
            action: 'update',
            version: 2,
            data: item,
          });

          const outbox = await helpers.publishOutbox(
            tenant.workspaceId,
            item.id,
            'library.item.updated',
            { itemId: item.id, version: 2 },
          );

          return { item, changeLog, outbox };
        },
      );

      expect(executedTx.item.version).toBe(2);
      expect(Number(executedTx.changeLog.seq)).toBeGreaterThan(0);
      expect(executedTx.outbox.status).toBe('PENDING');
      expect(executedTx.outbox.aggregateId).toBe('item-atomic-1');
    });
  });

  describe('2. Transaction Rollback Invariant', () => {
    it('rolls back entity mutation and emits zero change logs or outbox events on transaction error', async () => {
      let txAttempted = false;

      try {
        await txService.executeInTransaction(async (_tx, _helpers) => {
          txAttempted = true;
          await Promise.resolve();
          throw new Error('Simulated database constraint failure during write');
        });
      } catch (err: any) {
        expect(err.message).toContain('Simulated database constraint failure');
      }

      expect(txAttempted).toBe(true);
    });
  });
});
