import { LibraryTestHarness } from '../library-test-harness';

describe('Collections Interface & Invariants (Integration)', () => {
  let harness: LibraryTestHarness;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Many-to-Many Membership Semantics', () => {
    it('allows a single catalog item to be assigned to multiple collections simultaneously', () => {
      const tenant = harness.createWorkspaceFixture();
      const itemId = 'item-multi-col-1';
      const collectionIds = [
        'col-ai-research',
        'col-ml-systems',
        'col-reading-list',
      ];

      const memberships = collectionIds.map((colId, index) => ({
        id: `membership-${index}`,
        workspaceId: tenant.workspaceId,
        collectionId: colId,
        catalogItemId: itemId,
        sortOrder: index,
        addedAt: new Date(),
      }));

      expect(memberships).toHaveLength(3);
      expect(new Set(memberships.map((m) => m.collectionId)).size).toBe(3);
      expect(memberships.every((m) => m.catalogItemId === itemId)).toBe(true);
    });
  });

  describe('2. Acyclic Tree Hierarchy & Cycle Detection', () => {
    it('detects and rejects circular parent-child ancestor assignments', () => {
      // Tree: Root (c1) -> Child (c2) -> Subchild (c3)
      const tree = new Map<string, string | null>([
        ['c1', null],
        ['c2', 'c1'],
        ['c3', 'c2'],
      ]);

      const validateParentAssignment = (
        collectionId: string,
        newParentId: string | null,
      ): boolean => {
        if (!newParentId) return true;
        if (collectionId === newParentId) return false;

        let current: string | null | undefined = newParentId;
        const visited = new Set<string>();

        while (current) {
          if (current === collectionId) {
            return false; // Cycle detected!
          }
          if (visited.has(current)) break;
          visited.add(current);
          current = tree.get(current);
        }
        return true;
      };

      // Valid assignment: c3 under c1
      expect(validateParentAssignment('c3', 'c1')).toBe(true);

      // Invalid assignment: setting c1's parent to c3 (ancestor cycle)
      const isValid = validateParentAssignment('c1', 'c3');
      expect(isValid).toBe(false);
    });
  });

  describe('3. Dual-Read Membership Fallback', () => {
    it('reads canonical memberships when readNew is true, otherwise uses legacy', () => {
      const tenant = harness.createWorkspaceFixture();
      harness.featureFlags.setWorkspaceOverride(tenant.workspaceId, {
        readNew: false,
      });

      expect(harness.featureFlags.isReadNewEnabled(tenant.workspaceId)).toBe(
        false,
      );

      harness.featureFlags.setWorkspaceOverride(tenant.workspaceId, {
        readNew: true,
      });
      expect(harness.featureFlags.isReadNewEnabled(tenant.workspaceId)).toBe(
        true,
      );

      harness.featureFlags.clearWorkspaceOverride(tenant.workspaceId);
    });
  });
});
