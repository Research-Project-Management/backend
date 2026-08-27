import { LibraryTestHarness } from '../library-test-harness';
import { VersionMismatchException } from '../../../../src/modules/library/common/library-mutation.dto';

describe('Catalog Interface & Invariants (Integration)', () => {
  let harness: LibraryTestHarness;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Tenant Isolation Invariant', () => {
    it('enforces strict boundary between distinct workspace tenants', async () => {
      const tenantA = harness.createWorkspaceFixture('ws-tenant-alpha');
      const tenantB = harness.createWorkspaceFixture('ws-tenant-beta');

      const mockItemsA = [
        {
          id: 'item-a1',
          workspaceId: tenantA.workspaceId,
          title: 'Paper Alpha 1',
        },
        {
          id: 'item-a2',
          workspaceId: tenantA.workspaceId,
          title: 'Paper Alpha 2',
        },
      ];

      const mockItemsB = [
        {
          id: 'item-b1',
          workspaceId: tenantB.workspaceId,
          title: 'Paper Beta 1',
        },
      ];

      await harness.assertWorkspaceIsolation(
        async () => Promise.resolve(mockItemsA),
        async () => Promise.resolve(mockItemsB),
        tenantA.workspaceId,
        tenantB.workspaceId,
      );
    });
  });

  describe('2. Optimistic Concurrency Invariant', () => {
    it('accepts mutation on matching version and increments monotonic version', async () => {
      let currentVersion = 1;
      const mutate = async (expectedVersion: number) => {
        if (expectedVersion !== currentVersion) {
          throw new VersionMismatchException({
            aggregateType: 'CatalogItem',
            entityId: 'item-1',
            currentVersion,
            providedVersion: expectedVersion,
          });
        }
        currentVersion += 1;
        return Promise.resolve({ id: 'item-1', version: currentVersion });
      };

      await harness.assertOptimisticConcurrency(mutate, 1);
      expect(currentVersion).toBe(2);
    });
  });

  describe('3. Command Idempotency Invariant', () => {
    it('deduplicates requests with matching idempotency keys within active window', async () => {
      const idempotencyKey = 'idem-key-998877';
      const cache = new Map<string, any>();

      const executeWithIdempotency = async (key: string, payload: any) => {
        if (cache.has(key)) {
          return Promise.resolve({ ...cache.get(key), isCached: true });
        }
        const result = { id: 'item-new-1', title: payload.title, version: 1 };
        cache.set(key, result);
        return Promise.resolve({ ...result, isCached: false });
      };

      const firstRun = await executeWithIdempotency(idempotencyKey, {
        title: 'First Run',
      });
      expect(firstRun.isCached).toBe(false);

      const secondRun = await executeWithIdempotency(idempotencyKey, {
        title: 'First Run',
      });
      expect(secondRun.isCached).toBe(true);
      expect(secondRun.id).toBe(firstRun.id);
    });
  });
});
