import { SyncService } from '@/modules/library/legacy/sync/sync.service';

describe('Phase 9: Sync, Versioning & Offline-Ready Subsystem', () => {
  let syncService: SyncService;
  let mockCatalogRepo: any;

  const mockItem = {
    id: 'item-sync-101',
    workspaceId: 'ws-sync-1',
    title: 'Attention Is All You Need',
    version: 1,
    deletedAt: null,
  };

  beforeEach(() => {
    mockCatalogRepo = {
      resolveWorkspaceId: jest
        .fn()
        .mockImplementation((ws) => Promise.resolve(ws)),
      findItemByIdInWorkspace: jest.fn().mockImplementation((ws, id) => {
        if (id === mockItem.id) return Promise.resolve({ ...mockItem });
        return Promise.resolve(null);
      }),
      updateItem: jest.fn().mockImplementation((id, data) => {
        Object.assign(mockItem, data);
        return Promise.resolve(mockItem);
      }),
    };

    syncService = new SyncService(mockCatalogRepo);
  });

  describe('Monotonic Sequence & Change Feed', () => {
    it('records strictly monotonic sequence numbers for each change', async () => {
      const c1 = await syncService.recordChange(
        'ws-sync-1',
        'item',
        'item-1',
        'create',
        1,
      );
      const c2 = await syncService.recordChange(
        'ws-sync-1',
        'item',
        'item-2',
        'create',
        1,
      );
      const c3 = await syncService.recordChange(
        'ws-sync-1',
        'item',
        'item-1',
        'update',
        2,
      );

      expect(c1.seq).toBe(1);
      expect(c2.seq).toBe(2);
      expect(c3.seq).toBe(3);
    });

    it('returns incremental changes after a given sequence number', async () => {
      await syncService.recordChange(
        'ws-sync-1',
        'item',
        'item-1',
        'create',
        1,
      );
      await syncService.recordChange(
        'ws-sync-1',
        'item',
        'item-2',
        'create',
        1,
      );
      await syncService.recordChange(
        'ws-sync-1',
        'item',
        'item-3',
        'create',
        1,
      );

      const after1 = await syncService.getChanges('ws-sync-1', 1, 10);
      expect(after1.changes.length).toBe(2);
      expect(after1.changes[0].seq).toBe(2);
      expect(after1.changes[1].seq).toBe(3);
      expect(after1.latestSeq).toBe(3);
      expect(after1.hasMore).toBe(false);
    });
  });

  describe('Offline Batch Mutations & Conflict Detection (OCC)', () => {
    it('successfully applies offline mutations when baseVersion matches server version', async () => {
      const result = await syncService.pushChanges('ws-sync-1', [
        {
          entityType: 'item',
          entityId: 'item-sync-101',
          action: 'update',
          baseVersion: 1, // matches mockItem.version
          data: { title: 'Attention Is All You Need (Updated Edition)' },
        },
      ]);

      expect(result.applied.length).toBe(1);
      expect(result.applied[0].entityId).toBe('item-sync-101');
      expect(result.applied[0].newVersion).toBe(2);
      expect(result.conflicts.length).toBe(0);
      expect(mockItem.title).toBe(
        'Attention Is All You Need (Updated Edition)',
      );
    });

    it('detects concurrency conflict when baseVersion is stale (412 optimistic lock)', async () => {
      mockItem.version = 5; // Server already moved to version 5

      const result = await syncService.pushChanges('ws-sync-1', [
        {
          entityType: 'item',
          entityId: 'item-sync-101',
          action: 'update',
          baseVersion: 3, // Stale baseVersion from offline client
          data: { title: 'Conflicting Title' },
        },
      ]);

      expect(result.applied.length).toBe(0);
      expect(result.conflicts.length).toBe(1);
      expect(result.conflicts[0].entityId).toBe('item-sync-101');
      expect(result.conflicts[0].serverVersion).toBe(5);
      expect(result.conflicts[0].baseVersion).toBe(3);
      expect(result.conflicts[0].message).toContain(
        'Optimistic concurrency conflict',
      );
    });
  });
});
