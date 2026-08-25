import { Test, TestingModule } from '@nestjs/testing';
import { PageService } from '@/modules/document/page/page.service';
import { PageRepository } from '@/modules/document/page/page.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('PageService', () => {
  let service: PageService;
  let repo: PageRepository;
  let eventEmitter: EventEmitter2;

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
          provide: PageRepository,
          useValue: {
            findWorkspacePages: jest.fn(),
            findProjectPages: jest.fn(),
            findPageById: jest.fn(),
            findChildPages: jest.fn(),
            createPage: jest.fn(),
            updatePage: jest.fn(),
            deletePage: jest.fn(),
            incrementPageView: jest.fn(),
            findProjectWorkspaceId: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PageService>(PageService);
    repo = module.get<PageRepository>(PageRepository);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
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
    (repo.findProjectWorkspaceId as jest.Mock).mockResolvedValue('ws-resolved-1');
    (repo.createPage as jest.Mock).mockResolvedValue({
      id: 'pg-2',
      title: 'Project Doc',
      workspaceId: 'ws-resolved-1',
      projectId: 'proj-1',
      authorId: 'user-1',
    });

    const result = await service.createPage('', 'proj-1', 'user-1', {
      title: 'Project Doc',
    });

    expect(repo.findProjectWorkspaceId).toHaveBeenCalledWith('proj-1');
    expect(result.page.workspaceId).toBe('ws-resolved-1');
  });

  it('should create page successfully with direct workspaceId', async () => {
    (repo.createPage as jest.Mock).mockResolvedValue({
      id: 'pg-1',
      title: 'Introduction to Transformers',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      authorId: 'user-1',
    });

    const result = await service.createPage('ws-1', 'proj-1', 'user-1', {
      title: 'Introduction to Transformers',
    });

    expect(result.page.title).toBe('Introduction to Transformers');
    expect(result.page.id).toBe('pg-1');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'page.created',
      expect.objectContaining({
        workspaceId: 'ws-1',
        entityId: 'pg-1',
      }),
    );
  });

  it('should throw NotFoundException on deletePage when page does not exist', async () => {
    (repo.findPageById as jest.Mock).mockResolvedValue(null);

    await expect(service.deletePage('non-existent')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should delete page and emit activity event with proper workspace context', async () => {
    (repo.findPageById as jest.Mock).mockResolvedValue({
      id: 'pg-1',
      title: 'Existing Page',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      authorId: 'user-author-1',
    });
    (repo.deletePage as jest.Mock).mockResolvedValue({});

    const result = await service.deletePage('pg-1');

    expect(repo.deletePage).toHaveBeenCalledWith('pg-1');
    expect(result.message).toContain('successfully');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'page.deleted',
      expect.objectContaining({
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        actorId: 'user-author-1',
      }),
    );
  });
});
