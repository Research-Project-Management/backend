import { Test, TestingModule } from '@nestjs/testing';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { ThreadRepository } from '@/modules/ai/thread/thread.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ThreadService', () => {
  let service: ThreadService;
  let repo: jest.Mocked<ThreadRepository>;
  let cache: jest.Mocked<RedisCacheService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadService,
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: ThreadRepository,
          useValue: {
            findUserChats: jest.fn(),
            findChatById: jest.fn(),
            findPageChat: jest.fn(),
            deletePageChat: jest.fn(),
            createChat: jest.fn(),
            updateChat: jest.fn(),
            updateChatTitle: jest.fn(),
            createMessages: jest.fn(),
            deleteChat: jest.fn(),
            clearUserWorkspaceChats: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ThreadService>(ThreadService);
    repo = module.get(ThreadRepository);
    cache = module.get(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get user chat threads and cache result', async () => {
    repo.findUserChats.mockResolvedValue([
      {
        id: 'ch-1',
        title: 'Discussion on RAG',
        workspaceSlug: 'ws-1',
        userId: 'u-1',
        messages: [],
        documentIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    ]);

    const result = await service.getChats('ws-1', 'u-1');
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('Discussion on RAG');
    expect(cache.set).toHaveBeenCalled();
  });

  it('should return cached chat threads when present in Redis', async () => {
    cache.get.mockResolvedValue([
      { id: 'ch-cached', title: 'Cached Chat' } as any,
    ]);

    const result = await service.getChats('ws-1', 'u-1');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('ch-cached');
    expect(repo.findUserChats).not.toHaveBeenCalled();
  });

  it('should create new AI chat thread and invalidate cache', async () => {
    repo.createChat.mockResolvedValue({
      id: 'ch-new',
      title: 'New Research Chat',
      workspaceSlug: 'ws-1',
      userId: 'u-1',
      messages: [],
      documentIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await service.createChat('u-1', {
      workspaceSlug: 'ws-1',
      title: 'New Research Chat',
    });

    expect(result.id).toBe('ch-new');
    expect(result.title).toBe('New Research Chat');
    expect(cache.del).toHaveBeenCalled();
  });

  it('should get single chat thread by id', async () => {
    repo.findChatById.mockResolvedValue({
      id: 'ch-1',
      title: 'Thread 1',
      workspaceSlug: 'ws-1',
      userId: 'u-1',
      messages: [
        {
          id: 'm-1',
          role: 'user',
          content: 'What is FLUX?',
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await service.getChat('ch-1');
    expect(result.id).toBe('ch-1');
    expect(result.messages?.length).toBe(1);
    expect(cache.set).toHaveBeenCalled();
  });

  it('should throw NotFoundException when getting non-existent chat', async () => {
    repo.findChatById.mockResolvedValue(null);

    await expect(service.getChat('ch-non-existent')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should delete chat thread and invalidate cache', async () => {
    repo.findChatById.mockResolvedValue({
      id: 'ch-1',
      userId: 'u-1',
      workspaceSlug: 'ws-1',
    } as any);
    repo.deleteChat.mockResolvedValue({ id: 'ch-1' } as any);

    const result = await service.deleteChat('ch-1');
    expect(result.success).toBe(true);
    expect(cache.del).toHaveBeenCalled();
  });
});
