import { AccessRevocationListener } from '@/modules/realtime/manuscripts/access-revocation.listener';
import { RealtimeAccessService } from '@/modules/realtime/manuscripts/realtime-access.service';
import { ManuscriptsGateway } from '@/modules/realtime/manuscripts/manuscripts.gateway';

describe('Realtime Access Revocation & Role Updates (US7 & RT-08 / RT-10 / SC-007)', () => {
  let listener: AccessRevocationListener;
  let mockAccessService: jest.Mocked<RealtimeAccessService>;
  let mockGateway: Partial<ManuscriptsGateway>;

  const projectId = '01928374-beef-4000-8000-000000000001';
  const userIdA = '01928374-beef-4000-8000-000000000002';
  const userIdB = '01928374-beef-4000-8000-000000000003';
  const docId = '01928374-beef-4000-8000-000000000004';

  let socketA: any;
  let socketB: any;

  beforeEach(() => {
    socketA = {
      id: 'sock-user-A',
      data: {
        userId: userIdA,
        projectId,
        activeDocId: docId,
        authenticated: true,
      },
      emit: jest.fn(),
      leave: jest.fn().mockResolvedValue(undefined),
    };

    socketB = {
      id: 'sock-user-B',
      data: {
        userId: userIdB,
        projectId,
        activeDocId: docId,
        authenticated: true,
      },
      emit: jest.fn(),
      leave: jest.fn().mockResolvedValue(undefined),
    };

    mockAccessService = {
      evictCache: jest.fn(),
    } as any;

    mockGateway = {
      server: {
        fetchSockets: jest.fn().mockResolvedValue([socketA, socketB]),
      } as any,
    };

    listener = new AccessRevocationListener(
      mockAccessService,
      mockGateway as ManuscriptsGateway,
    );
  });

  describe('1. Member Removed Event Handling', () => {
    it('evicts access cache and removes socket from rooms with access:revoked event', async () => {
      await listener.handleMemberRemoved({
        projectId,
        userId: userIdA,
      });

      // 1. Cache evicted
      expect(mockAccessService.evictCache).toHaveBeenCalledWith(
        projectId,
        userIdA,
      );

      // 2. Socket A notified with access:revoked
      expect(socketA.emit).toHaveBeenCalledWith('access:revoked', { projectId });

      // 3. Socket A removed from project and doc rooms
      expect(socketA.leave).toHaveBeenCalledWith(`project:${projectId}`);
      expect(socketA.leave).toHaveBeenCalledWith(`doc:${projectId}:${docId}`);

      // 4. Socket A joined context cleared
      expect(socketA.data.projectId).toBeNull();
      expect(socketA.data.activeDocId).toBeNull();

      // 5. Socket B remains completely untouched
      expect(socketB.emit).not.toHaveBeenCalled();
      expect(socketB.leave).not.toHaveBeenCalled();
      expect(socketB.data.projectId).toBe(projectId);
      expect(socketB.data.activeDocId).toBe(docId);
    });

    it('correctly parses DomainActivityEvent structure (entityId, oldValue)', async () => {
      await listener.handleMemberRemoved({
        entityId: projectId,
        oldValue: userIdA,
      });

      expect(mockAccessService.evictCache).toHaveBeenCalledWith(
        projectId,
        userIdA,
      );
      expect(socketA.emit).toHaveBeenCalledWith('access:revoked', { projectId });
    });
  });

  describe('2. Member Updated Event Handling', () => {
    it('evicts access cache on member role change so next operation re-evaluates permissions', async () => {
      await listener.handleMemberUpdated({
        projectId,
        userId: userIdA,
        role: 'reviewer',
      });

      expect(mockAccessService.evictCache).toHaveBeenCalledWith(
        projectId,
        userIdA,
      );
    });

    it('handles DomainActivityEvent metadata structure on role update', async () => {
      await listener.handleMemberUpdated({
        entityId: projectId,
        metadata: { targetId: userIdA, newRole: 'reviewer' },
      });

      expect(mockAccessService.evictCache).toHaveBeenCalledWith(
        projectId,
        userIdA,
      );
    });
  });
});
