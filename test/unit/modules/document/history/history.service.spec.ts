import { Test, TestingModule } from '@nestjs/testing';
import { HistoryService } from '@/modules/document/history/history.service';
import { HistoryRepository } from '@/modules/document/history/history.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { NotFoundException } from '@nestjs/common';

describe('HistoryService', () => {
  let service: HistoryService;
  let repo: jest.Mocked<HistoryRepository>;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HistoryService,
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            wrap: jest.fn((key, fn) => fn()),
          },
        },
        {
          provide: HistoryRepository,
          useValue: {
            findPageVersions: jest.fn(),
            findVersionById: jest.fn(),
            createVersion: jest.fn(),
            deleteVersion: jest.fn(),
            findPageById: jest.fn(),
            updatePage: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<HistoryService>(HistoryService);
    repo = module.get(HistoryRepository);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get version history for a page', async () => {
    repo.findPageVersions.mockResolvedValue([
      { id: 'v-1', title: 'Draft v1', pageId: 'p-1' } as any,
    ]);

    const result = await service.getHistory('p-1');
    expect(result.history.length).toBe(1);
  });

  it('should create version snapshot and invalidate cache', async () => {
    repo.findPageById.mockResolvedValue({
      id: 'p-1',
      title: 'Original Title',
      content: { blocks: [] },
    } as any);

    repo.createVersion.mockResolvedValue({
      id: 'v-1',
      title: 'Original Title',
      pageId: 'p-1',
    } as any);

    const result = await service.createVersion('p-1', 'user-1', {
      title: 'Original Title',
    });

    expect(result.version.id).toBe('v-1');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should restore previous version into page content', async () => {
    repo.findVersionById.mockResolvedValue({
      id: 'v-1',
      title: 'Previous Draft',
      content: '{"blocks":[{"text":"Hello"}]}',
      pageId: 'p-1',
    } as any);

    repo.updatePage.mockResolvedValue({
      id: 'p-1',
      title: 'Previous Draft',
      content: { blocks: [{ text: 'Hello' }] },
    } as any);

    const result = await service.restoreVersion('p-1', 'v-1');

    expect(result.message).toContain('restored successfully');
    expect(repo.updatePage).toHaveBeenCalledWith(
      'p-1',
      expect.objectContaining({
        title: 'Previous Draft',
      }),
    );
    expect(cache.del).toHaveBeenCalled();
  });
});
