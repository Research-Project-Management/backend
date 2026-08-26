import { LibraryTestHarness } from '../library-test-harness';
import { ChangeLogRepository } from '../../../../src/contexts/library/sync-core/change-log.repository';

jest.setTimeout(60000);

describe('Sync Sequence Concurrency & Isolation Invariants (Integration)', () => {
  let harness: LibraryTestHarness;
  let changeLogRepo: ChangeLogRepository;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    changeLogRepo = harness.moduleRef.get(ChangeLogRepository);
  });


  afterAll(async () => {
    await harness.close();
  });

  describe('1. Monotonic Per-Workspace Sequence Allocation', () => {
    it('allocates strictly ascending sequence numbers without collisions', async () => {
      const tenant = harness.createWorkspaceFixture();

      const seq1 = await changeLogRepo.allocateNextSequence(tenant.workspaceId);
      const seq2 = await changeLogRepo.allocateNextSequence(tenant.workspaceId);
      const seq3 = await changeLogRepo.allocateNextSequence(tenant.workspaceId);

      expect(Number(seq2)).toBe(Number(seq1) + 1);
      expect(Number(seq3)).toBe(Number(seq2) + 1);
    });
  });

  describe('2. Multi-Tenant Sequence Independence', () => {
    it('maintains completely isolated sequence streams across distinct workspaces', async () => {
      const tenantA = harness.createWorkspaceFixture();
      const tenantB = harness.createWorkspaceFixture();

      const seqA1 = await changeLogRepo.allocateNextSequence(
        tenantA.workspaceId,
      );
      const seqA2 = await changeLogRepo.allocateNextSequence(
        tenantA.workspaceId,
      );
      const seqB1 = await changeLogRepo.allocateNextSequence(
        tenantB.workspaceId,
      );
      const seqA3 = await changeLogRepo.allocateNextSequence(
        tenantA.workspaceId,
      );
      const seqB2 = await changeLogRepo.allocateNextSequence(
        tenantB.workspaceId,
      );

      expect(Number(seqA1)).toBe(1);
      expect(Number(seqA2)).toBe(2);
      expect(Number(seqA3)).toBe(3);

      expect(Number(seqB1)).toBe(1);
      expect(Number(seqB2)).toBe(2);
    });
  });
});
