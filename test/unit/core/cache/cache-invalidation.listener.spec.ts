import { Test, TestingModule } from '@nestjs/testing';
import { CacheInvalidationListener } from '@/core/cache/cache-invalidation.listener';
import { RedisCacheService } from '@/core/cache/redis-cache.service';

describe('CacheInvalidationListener', () => {
  let listener: CacheInvalidationListener;
  let redisCache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const mockRedisCache = {
      del: jest.fn().mockResolvedValue(undefined),
      delPattern: jest.fn().mockResolvedValue(undefined),
      invalidateWorkspace: jest.fn().mockResolvedValue(undefined),
      invalidateProject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheInvalidationListener,
        {
          provide: RedisCacheService,
          useValue: mockRedisCache,
        },
      ],
    }).compile();

    listener = module.get<CacheInvalidationListener>(CacheInvalidationListener);
    redisCache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(listener).toBeDefined();
  });

  it('should handle manual invalidation with workspaceId and pattern', async () => {
    await listener.handleManualInvalidation({
      workspaceId: 'ws-1',
      pattern: 'custom:*',
      key: 'single-key',
    });

    expect(redisCache.del).toHaveBeenCalledWith('single-key');
    expect(redisCache.delPattern).toHaveBeenCalledWith('custom:*');
    expect(redisCache.invalidateWorkspace).toHaveBeenCalledWith('ws-1');
  });

  it('should invalidate task caches on task events', async () => {
    await listener.handleTaskChanged({
      entityType: 'task',
      entityId: 't-123',
      verb: 'updated',
      projectId: 'proj-456',
      workspaceId: 'ws-789',
    });

    expect(redisCache.delPattern).toHaveBeenCalledWith('tasks:proj-456:*');
    expect(redisCache.delPattern).toHaveBeenCalledWith(
      'analytics:project:proj-456:*',
    );
    expect(redisCache.delPattern).toHaveBeenCalledWith(
      'analytics:workspace:ws-789:*',
    );
    expect(redisCache.del).toHaveBeenCalledWith('task:t-123');
  });

  it('should invalidate paper caches on paper events', async () => {
    await listener.handlePaperChanged({
      entityType: 'paper',
      entityId: 'p-100',
      verb: 'deleted',
      workspaceId: 'ws-999',
    });

    expect(redisCache.delPattern).toHaveBeenCalledWith('papers:ws-999:*');
    expect(redisCache.delPattern).toHaveBeenCalledWith('library:ws-999:*');
    expect(redisCache.del).toHaveBeenCalledWith('paper:p-100');
    expect(redisCache.del).toHaveBeenCalledWith('paper:bundle:p-100');
  });
});
