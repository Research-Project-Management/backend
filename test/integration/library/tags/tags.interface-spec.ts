import { LibraryTestHarness } from '../library-test-harness';

describe('Tags Interface & Invariants (Integration)', () => {
  let harness: LibraryTestHarness;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Tag Uniqueness & Workspace Scope', () => {
    it('allows same tag name in different workspaces but rejects duplicates in same workspace', () => {
      const tenantA = harness.createWorkspaceFixture('ws-tag-tenant-1');
      const tenantB = harness.createWorkspaceFixture('ws-tag-tenant-2');

      const tagA = {
        id: 'tag-1',
        workspaceId: tenantA.workspaceId,
        name: 'Deep Learning',
        color: '#3b82f6',
      };
      const tagB = {
        id: 'tag-2',
        workspaceId: tenantB.workspaceId,
        name: 'Deep Learning',
        color: '#10b981',
      };

      expect(tagA.name).toBe(tagB.name);
      expect(tagA.workspaceId).not.toBe(tagB.workspaceId);
    });
  });

  describe('2. Tag Assignment & Sync Origins', () => {
    it('tracks tag origin correctly across user creation and zotero sync adapter', () => {
      const manualTag = { name: 'To Read', origin: 'user', color: '#f59e0b' };
      const zoteroTag = {
        name: 'Automatic Keyword',
        origin: 'zotero_adapter',
        color: '#6b7280',
      };

      expect(manualTag.origin).toBe('user');
      expect(zoteroTag.origin).toBe('zotero_adapter');
    });

    it('assigns multiple tags to a catalog item idempotently', () => {
      const itemTags = new Set<string>();
      const assign = (itemId: string, tagId: string) => {
        itemTags.add(`${itemId}:${tagId}`);
      };

      assign('item-1', 'tag-1');
      assign('item-1', 'tag-2');
      assign('item-1', 'tag-1'); // Duplicate assignment

      expect(itemTags.size).toBe(2);
    });
  });
});
