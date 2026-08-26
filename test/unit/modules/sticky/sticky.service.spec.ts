import { Test, TestingModule } from '@nestjs/testing';
import { StickyService } from '@/modules/sticky/sticky.service';
import { StickyRepository } from '@/modules/sticky/sticky.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { ForbiddenException } from '@nestjs/common';

describe('StickyService', () => {
  let service: StickyService;
  let repo: jest.Mocked<StickyRepository>;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StickyService,
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: StickyRepository,
          useValue: {
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            findStickyById: jest.fn(),
            findWorkspaceStickies: jest.fn(),
            findProjectStickies: jest.fn(),
            countWorkspaceStickies: jest.fn().mockResolvedValue(0),
            countProjectStickies: jest.fn().mockResolvedValue(0),
            createSticky: jest.fn(),
            updateSticky: jest.fn(),
            deleteSticky: jest.fn(),
            reorderStickies: jest.fn(),
            findProjectWorkspaceId: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<StickyService>(StickyService);
    repo = module.get(StickyRepository);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get workspace stickies scoped to user and cache result', async () => {
    repo.findWorkspaceStickies.mockResolvedValue([
      {
        id: 's-1',
        content: 'Idea 1',
        positionX: 10,
        positionY: 20,
        userId: 'user-1',
        workspaceId: 'ws-1',
      } as any,
    ]);

    const result = await service.getWorkspaceStickies('ws-1', 'user-1');

    expect(repo.findWorkspaceStickies).toHaveBeenCalledWith('ws-1', 'user-1');
    expect(result.stickies.length).toBe(1);
    expect(result.stickies[0]?.position).toEqual({ x: 10, y: 20 });
    expect(cache.set).toHaveBeenCalled();
  });

  it('should return cached stickies when available in Redis', async () => {
    cache.get.mockResolvedValue({
      stickies: [
        { id: 's-cached', content: 'Cached note', position: { x: 0, y: 0 } },
      ],
    });

    const result = await service.getWorkspaceStickies('ws-1', 'user-1');
    expect(result.stickies.length).toBe(1);
    expect(result.stickies[0]?.id).toBe('s-cached');
    expect(repo.findWorkspaceStickies).not.toHaveBeenCalled();
  });

  it('should create workspace sticky and invalidate cache', async () => {
    repo.createSticky.mockResolvedValue({
      id: 's-1',
      content: 'Brainstorm ideas',
      color: 'yellow-1',
      positionX: 100,
      positionY: 200,
      userId: 'user-1',
      workspaceId: 'ws-1',
    } as any);

    const result = await service.createWorkspaceSticky('ws-1', 'user-1', {
      content: 'Brainstorm ideas',
      position: { x: 100, y: 200 },
    });

    expect(result.sticky?.content).toBe('Brainstorm ideas');
    expect(result.sticky?.id).toBe('s-1');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should throw ForbiddenException when updating sticky owned by another user', async () => {
    repo.findStickyById.mockResolvedValue({
      id: 's-1',
      userId: 'user-2',
    } as any);

    await expect(
      service.updateSticky('s-1', 'user-1', { content: 'Hacked' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should update sticky and invalidate cache when user is owner', async () => {
    repo.findStickyById.mockResolvedValue({
      id: 's-1',
      userId: 'user-1',
      workspaceId: 'ws-1',
      projectId: null,
    } as any);
    repo.updateSticky.mockResolvedValue({
      id: 's-1',
      content: 'Updated content',
      positionX: 50,
      positionY: 50,
      userId: 'user-1',
      workspaceId: 'ws-1',
    } as any);

    const result = await service.updateSticky('s-1', 'user-1', {
      content: 'Updated content',
    });

    expect(result.sticky?.content).toBe('Updated content');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should throw ForbiddenException when deleting sticky owned by another user', async () => {
    repo.findStickyById.mockResolvedValue({
      id: 's-1',
      userId: 'user-2',
    } as any);

    await expect(service.deleteSticky('s-1', 'user-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should delete sticky successfully when user is owner', async () => {
    repo.findStickyById.mockResolvedValue({
      id: 's-1',
      userId: 'user-1',
      workspaceId: 'ws-1',
      projectId: null,
    } as any);
    repo.deleteSticky.mockResolvedValue({ id: 's-1' } as any);

    const result = await service.deleteSticky('s-1', 'user-1');

    expect(repo.deleteSticky).toHaveBeenCalledWith('s-1');
    expect(result.success).toBe(true);
    expect(cache.del).toHaveBeenCalled();
  });
});
