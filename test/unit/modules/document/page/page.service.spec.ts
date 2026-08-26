import { Test, TestingModule } from '@nestjs/testing';
import { PageService } from '@/modules/document/page/page.service';
import { PageRepository } from '@/modules/document/page/page.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('PageService', () => {
  let service: PageService;
  let repo: jest.Mocked<PageRepository>;
  let eventEmitter: EventEmitter2;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PageService,
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
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
          provide: PageRepository,
          useValue: {
            findWorkspacePages: jest.fn(),
            findProjectPages: jest.fn(),
            findProjectPageTree: jest.fn(),
            findPageById: jest.fn(),
            findChildPages: jest.fn(),
            createPage: jest.fn(),
            updatePage: jest.fn(),
            softDeletePage: jest.fn(),
            restorePage: jest.fn(),
            deletePage: jest.fn(),
            incrementPageView: jest.fn(),
            findProjectWorkspaceId: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PageService>(PageService);
    repo = module.get(PageRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw BadRequestException if workspace context cannot be determined', async () => {
    await expect(
      service.createPage('', '', 'user-1', {
        title: 'Orphan Page',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should resolve workspaceId from project if not passed directly', async () => {
    repo.findProjectWorkspaceId.mockResolvedValue('ws-resolved-1');
    repo.createPage.mockResolvedValue({
      id: 'pg-2',
      title: 'Project Doc',
      workspaceId: 'ws-resolved-1',
      projectId: 'proj-1',
      authorId: 'user-1',
    } as any);

    const result = await service.createPage('', 'proj-1', 'user-1', {
      title: 'Project Doc',
    });

    expect(repo.findProjectWorkspaceId).toHaveBeenCalledWith('proj-1');
    expect(result.page?.workspaceId).toBe('ws-resolved-1');
  });

  it('should create page successfully and invalidate cache', async () => {
    repo.createPage.mockResolvedValue({
      id: 'pg-1',
      title: 'Introduction to Transformers',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      authorId: 'user-1',
    } as any);

    const result = await service.createPage('ws-1', 'proj-1', 'user-1', {
      title: 'Introduction to Transformers',
    });

    expect(result.page?.title).toBe('Introduction to Transformers');
    expect(result.page?.id).toBe('pg-1');
    expect(cache.del).toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'page.created',
      expect.objectContaining({
        workspaceId: 'ws-1',
        entityId: 'pg-1',
      }),
    );
  });

  it('should prevent circular parenting during updatePage', async () => {
    repo.findPageById.mockImplementation((id: string) => {
      if (id === 'pg-1') {
        return Promise.resolve({ id: 'pg-1', parentPageId: null } as any);
      }
      if (id === 'pg-2') {
        return Promise.resolve({ id: 'pg-2', parentPageId: 'pg-1' } as any);
      }
      return Promise.resolve(null);
    });

    // Attempting to set pg-1's parent to pg-2 (which is child of pg-1)
    await expect(
      service.updatePage('pg-1', { parentPageId: 'pg-2' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should soft delete page and invalidate cache', async () => {
    repo.findPageById.mockResolvedValue({
      id: 'pg-1',
      title: 'Existing Page',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      authorId: 'user-author-1',
    } as any);
    repo.softDeletePage.mockResolvedValue({ id: 'pg-1' } as any);

    const result = await service.deletePage('pg-1');

    expect(repo.softDeletePage).toHaveBeenCalledWith('pg-1');
    expect(result.message).toContain('successfully');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should restore soft-deleted page', async () => {
    repo.restorePage.mockResolvedValue({
      id: 'pg-1',
      projectId: 'proj-1',
    } as any);

    const result = await service.restorePage('pg-1');
    expect(result.message).toContain('restored successfully');
    expect(repo.restorePage).toHaveBeenCalledWith('pg-1');
  });
});
