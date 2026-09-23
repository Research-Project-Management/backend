import { SyncController } from '@/modules/library/shared-kernel/presentation/sync.controller';
import { TransactionService } from '@/modules/library/shared-kernel/outbox/transaction.service';
import { SyncQueryDto } from '@/modules/library/shared-kernel/presentation/dtos/sync-query.dto';

describe('SyncController (Library Distributed Sync API)', () => {
  let controller: SyncController;
  let transactionServiceMock: jest.Mocked<TransactionService>;

  beforeEach(() => {
    transactionServiceMock = {
      getLatestSequence: jest.fn(),
      getChangesSince: jest.fn(),
      getTombstonesSince: jest.fn(),
    } as unknown as jest.Mocked<TransactionService>;

    controller = new SyncController(transactionServiceMock);
  });

  describe('getSyncVersion', () => {
    it('should return the current sequence version for a personal user library', async () => {
      transactionServiceMock.getLatestSequence.mockResolvedValue(BigInt(42));

      const result = await controller.getSyncVersion('user-123');

      expect(result).toEqual({
        version: '42',
        scope: 'user',
        scopeId: 'user-123',
      });
      expect(transactionServiceMock.getLatestSequence).toHaveBeenCalledWith({
        userId: 'user-123',
      });
    });

    it('should return the current sequence version for a project library', async () => {
      transactionServiceMock.getLatestSequence.mockResolvedValue(BigInt(105));

      const result = await controller.getSyncVersion(
        'user-123',
        'proj-456',
        undefined,
      );

      expect(result).toEqual({
        version: '105',
        scope: 'project',
        scopeId: 'proj-456',
      });
      expect(transactionServiceMock.getLatestSequence).toHaveBeenCalledWith({
        projectId: 'proj-456',
      });
    });
  });

  describe('getChanges', () => {
    it('should retrieve incremental changes and serialize BigInt seq to string', async () => {
      const mockChanges = [
        {
          id: 'change-1',
          seq: BigInt(5),
          userId: 'user-123',
          projectId: null,
          entityType: 'item',
          entityId: 'item-abc',
          action: 'create',
          version: 1,
          data: { title: 'Transformer Paper' },
          createdAt: new Date('2026-09-22T10:00:00Z'),
        },
        {
          id: 'change-2',
          seq: BigInt(6),
          userId: 'user-123',
          projectId: null,
          entityType: 'collection',
          entityId: 'col-xyz',
          action: 'update',
          version: 2,
          data: { name: 'Deep Learning' },
          createdAt: new Date('2026-09-22T10:05:00Z'),
        },
      ];

      transactionServiceMock.getChangesSince.mockResolvedValue(mockChanges as any);

      const query: SyncQueryDto = { since: '4', limit: 50 };
      const result = await controller.getChanges('user-123', query);

      expect(result.since).toBe('4');
      expect(result.count).toBe(2);
      expect(result.hasMore).toBe(false);
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0].seq).toBe('5');
      expect(result.changes[0].entityType).toBe('item');
      expect(result.changes[1].seq).toBe('6');
      expect(result.changes[1].entityType).toBe('collection');

      expect(transactionServiceMock.getChangesSince).toHaveBeenCalledWith(
        { userId: 'user-123' },
        BigInt(4),
        50,
      );
    });

    it('should default since to 0 and limit to 100 if query is omitted', async () => {
      transactionServiceMock.getChangesSince.mockResolvedValue([]);

      const result = await controller.getChanges('user-123', {});

      expect(result.since).toBe('0');
      expect(result.count).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(transactionServiceMock.getChangesSince).toHaveBeenCalledWith(
        { userId: 'user-123' },
        BigInt(0),
        100,
      );
    });
  });

  describe('getTombstones', () => {
    it('should retrieve tombstones and serialize BigInt seq to string', async () => {
      const mockTombstones = [
        {
          id: 'tomb-1',
          seq: BigInt(8),
          userId: 'user-123',
          projectId: null,
          entityType: 'item',
          entityId: 'deleted-item-99',
          deletedById: 'user-123',
          deletedAt: new Date('2026-09-22T11:00:00Z'),
        },
      ];

      transactionServiceMock.getTombstonesSince.mockResolvedValue(
        mockTombstones as any,
      );

      const query: SyncQueryDto = { since: '5', limit: 20 };
      const result = await controller.getTombstones('user-123', query);

      expect(result.since).toBe('5');
      expect(result.count).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(result.tombstones[0].seq).toBe('8');
      expect(result.tombstones[0].entityId).toBe('deleted-item-99');

      expect(transactionServiceMock.getTombstonesSince).toHaveBeenCalledWith(
        { userId: 'user-123' },
        BigInt(5),
        20,
      );
    });
  });
});
