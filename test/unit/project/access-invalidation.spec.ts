import { CacheInvalidationListener } from '@/core/infrastructure/redis/invalidation.listener';
import { RedisCacheService } from '@/core/infrastructure/redis/redis.service';

describe('Zero-Latency Access Revocation & Cache Invalidation', () => {
  let listener: CacheInvalidationListener;
  let mockRedis: jest.Mocked<Partial<RedisCacheService>>;

  const projectId = 'proj-9999-uuid';
  const targetUserId = 'user-kicked-uuid';
  const newOwnerId = 'user-promoted-uuid';

  beforeEach(() => {
    mockRedis = {
      del: jest.fn().mockResolvedValue(1),
      delPattern: jest.fn().mockResolvedValue(1),
      invalidateUser: jest.fn().mockResolvedValue(undefined),
      invalidateProject: jest.fn().mockResolvedValue(undefined),
      invalidateScope: jest.fn().mockResolvedValue(undefined),
    };
    listener = new CacheInvalidationListener(mockRedis as RedisCacheService);
  });

  it('should immediately evict member access context, role, and permission keys on project.member_removed', async () => {
    await listener.handleProjectChanged({
      projectId,
      verb: 'member_removed',
      entityId: projectId,
      oldValue: targetUserId,
    });

    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:${projectId}:${targetUserId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:role:${projectId}:${targetUserId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:perms:${projectId}:${targetUserId}`);
  });

  it('should immediately evict access cache on project.member_updated (role change / demotion)', async () => {
    await listener.handleProjectChanged({
      projectId,
      verb: 'member_updated',
      entityId: projectId,
      userId: targetUserId,
    });

    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:${projectId}:${targetUserId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:role:${projectId}:${targetUserId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:perms:${projectId}:${targetUserId}`);
  });

  it('should immediately evict access caches for BOTH previous and new owners on project.ownership_transferred', async () => {
    await listener.handleProjectChanged({
      projectId,
      verb: 'ownership_transferred',
      entityId: projectId,
      oldValue: targetUserId,
      newValue: newOwnerId,
    } as any);

    // Evicts previous owner
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:${projectId}:${targetUserId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:role:${projectId}:${targetUserId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:perms:${projectId}:${targetUserId}`);

    // Evicts new owner
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:${projectId}:${newOwnerId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:role:${projectId}:${newOwnerId}`);
    expect(mockRedis.del).toHaveBeenCalledWith(`project:access:perms:${projectId}:${newOwnerId}`);
  });
});
