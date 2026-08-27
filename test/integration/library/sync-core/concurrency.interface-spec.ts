import { LibraryTestHarness } from '../library-test-harness';
import { ChangeLogRepository } from '../../../../src/modules/library/sync-core/change-log.repository';

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
      const tenant = await harness.seedWorkspaceFixture();

      const seq1 = await changeLogRepo.allocateNextSequence(tenant.workspaceId);
      const seq2 = await changeLogRepo.allocateNextSequence(tenant.workspaceId);
      const seq3 = await changeLogRepo.allocateNextSequence(tenant.workspaceId);

      expect(Number(seq2)).toBe(Number(seq1) + 1);
      expect(Number(seq3)).toBe(Number(seq2) + 1);
    });
  });

  describe('2. Multi-Tenant Sequence Independence', () => {
    it('maintains completely isolated sequence streams across distinct workspaces', async () => {
      const tenantA = await harness.seedWorkspaceFixture();
      const tenantB = await harness.seedWorkspaceFixture();

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

  describe('3. Two Concurrent Application Instances', () => {
    it('allocates unique, collision-free monotonic sequences when two concurrent application instances write in parallel', async () => {
      const tenant = await harness.seedWorkspaceFixture();

      // Simulate two separate application instances connected to the same DB
      const instanceA = new ChangeLogRepository(harness.prisma);
      const instanceB = new ChangeLogRepository(harness.prisma);

      const allocationsCount = 25;
      const promisesA = Array.from({ length: allocationsCount }, () =>
        instanceA.allocateNextSequence(tenant.workspaceId),
      );
      const promisesB = Array.from({ length: allocationsCount }, () =>
        instanceB.allocateNextSequence(tenant.workspaceId),
      );

      const allAllocated = await Promise.all([...promisesA, ...promisesB]);
      const numbers = allAllocated
        .map((seq) => Number(seq))
        .sort((a, b) => a - b);

      // Verify exactly 50 numbers allocated
      expect(numbers).toHaveLength(50);

      // Verify set contains no duplicates
      const uniqueSet = new Set(numbers);
      expect(uniqueSet.size).toBe(50);

      // Verify sequence is strictly 1 to 50
      expect(numbers[0]).toBe(1);
      expect(numbers[49]).toBe(50);
    });
  });
});
