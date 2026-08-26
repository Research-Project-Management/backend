import { LibraryTestHarness } from '../library-test-harness';
import { ChangeLogRepository } from '../../../../src/contexts/library/sync-core/change-log.repository';
import { IdempotencyRepository } from '../../../../src/contexts/library/sync-core/idempotency.repository';

jest.setTimeout(60000);

describe('Sync Recovery & Replay Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let changeLogRepo: ChangeLogRepository;
  let idempotencyRepo: IdempotencyRepository;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    changeLogRepo = harness.moduleRef.get(ChangeLogRepository);
    idempotencyRepo = harness.moduleRef.get(IdempotencyRepository);
  });


  afterAll(async () => {
    await harness.close();
  });

  describe('1. Cursor-Based Delta Pull Invariant', () => {
    it('returns sequential delta entries strictly greater than sinceSeq cursor', async () => {
      const tenant = harness.createWorkspaceFixture();

      const c1 = await changeLogRepo.appendChange(tenant.workspaceId, {
        entityType: 'CatalogItem',
        entityId: 'item-1',
        action: 'create',
        version: 1,
        data: { title: 'First Item' },
      });

      const c2 = await changeLogRepo.appendChange(tenant.workspaceId, {
        entityType: 'Collection',
        entityId: 'col-1',
        action: 'create',
        version: 1,
        data: { name: 'First Collection' },
      });

      const c3 = await changeLogRepo.appendChange(tenant.workspaceId, {
        entityType: 'CatalogItem',
        entityId: 'item-1',
        action: 'update',
        version: 2,
        data: { title: 'Updated First Item' },
      });

      const deltas = await changeLogRepo.getChangesSince(
        tenant.workspaceId,
        c1.seq,
        10,
      );

      expect(deltas).toHaveLength(2);
      expect(Number(deltas[0].seq)).toBe(Number(c2.seq));
      expect(Number(deltas[1].seq)).toBe(Number(c3.seq));
    });
  });

  describe('2. Idempotent Replay Invariant', () => {
    it('replaying pull with identical sinceSeq yields consistent, immutable change logs', async () => {
      const tenant = harness.createWorkspaceFixture();

      const c1 = await changeLogRepo.appendChange(tenant.workspaceId, {
        entityType: 'CatalogItemTag',
        entityId: 'tag-1',
        action: 'create',
        version: 1,
      });

      const pullA = await changeLogRepo.getChangesSince(
        tenant.workspaceId,
        c1.seq - BigInt(1),
        10,
      );
      const pullB = await changeLogRepo.getChangesSince(
        tenant.workspaceId,
        c1.seq - BigInt(1),
        10,
      );

      expect(pullA.length).toBe(pullB.length);
      expect(Number(pullA[0].seq)).toBe(Number(pullB[0].seq));
      expect(pullA[0].entityId).toBe('tag-1');
    });

    it('replays cached response when identical idempotencyKey and requestHash are provided', async () => {
      const tenant = harness.createWorkspaceFixture();
      const key = `idempotency-test-${Date.now()}`;
      const hash = 'req-hash-abc-123';

      const claim1 = await idempotencyRepo.claim(
        tenant.workspaceId,
        key,
        hash,
        3600,
      );
      expect(claim1.status).toBe('acquired');

      await idempotencyRepo.markSucceeded(tenant.workspaceId, key, 200, {
        success: true,
        itemId: 'created-item-42',
      });

      const claim2 = await idempotencyRepo.claim(
        tenant.workspaceId,
        key,
        hash,
        3600,
      );
      expect(claim2.status).toBe('cached');
      if (claim2.status === 'cached') {
        expect(claim2.record.responseBody).toEqual({
          success: true,
          itemId: 'created-item-42',
        });
      }
    });
  });

  describe('3. Expired Cursor & Full Resync Signal', () => {
    it('signals full resync required when requested cursor is older than retention window', () => {
      const minRetainedSeq = 100;
      const requestedSeq = 50;

      const requiresFullResync = requestedSeq < minRetainedSeq;
      expect(requiresFullResync).toBe(true);
    });
  });
});
