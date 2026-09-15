import { Test, TestingModule } from '@nestjs/testing';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { ThreadRepository } from '@/modules/ai/thread/thread.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import {
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';

describe('ThreadService (Server-Authoritative Invariants)', () => {
  let service: ThreadService;
  let repo: jest.Mocked<ThreadRepository>;
  let prisma: any;
  let cache: jest.Mocked<RedisCacheService>;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChatId = '22222222-2222-2222-2222-222222222222';
  const mockProjectId = '33333333-3333-3333-3333-333333333333';
  const mockPageId = '44444444-4444-4444-4444-444444444444';

  const mockChat = {
    id: mockChatId,
    userId: mockUserId,
    projectId: mockProjectId,
    pageId: null,
    title: 'Research Discussion',
    summary: '',
    keyFacts: [],
    openQuestions: [],
    documentIds: [],
    createdAt: new Date('2026-09-15T00:00:00Z'),
    updatedAt: new Date('2026-09-15T00:00:00Z'),
    messages: [
      {
        id: 'msg-1',
        chatId: mockChatId,
        role: 'user' as const,
        content: 'Explain the methodology',
        sources: [],
        widgets: [],
        selectionContext: null,
        createdAt: new Date('2026-09-15T00:00:00Z'),
      },
      {
        id: 'msg-2',
        chatId: mockChatId,
        role: 'assistant' as const,
        content: 'The methodology utilizes Tectonic compilation...',
        sources: [],
        widgets: [],
        selectionContext: null,
        createdAt: new Date('2026-09-15T00:01:00Z'),
      },
    ],
  };

  beforeEach(async () => {
    const mockRepo = {
      findUserChats: jest.fn(),
      findChatById: jest.fn(),
      findChatByIdAndUser: jest.fn(),
      findPageChat: jest.fn(),
      deletePageChat: jest.fn(),
      createChat: jest.fn(),
      updateChat: jest.fn(),
      updateChatTitle: jest.fn(),
      appendMessage: jest.fn(),
      createMessages: jest.fn(),
      deleteChat: jest.fn(),
      clearUserChats: jest.fn(),
    };

    const mockPrismaClient = {
      project: {
        findFirst: jest.fn(),
      },
      page: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      aiChat: {
        findFirst: jest.fn(),
      },
    };

    const mockCacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadService,
        { provide: ThreadRepository, useValue: mockRepo },
        { provide: PrismaService, useValue: mockPrismaClient },
        { provide: RedisCacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<ThreadService>(ThreadService);
    repo = module.get(ThreadRepository);
    prisma = module.get(PrismaService);
    cache = module.get(RedisCacheService);
  });

  describe('createChat', () => {
    it('should sanitize title and strip malicious HTML/scripts', async () => {
      repo.createChat.mockResolvedValue({
        ...mockChat,
        title: 'Safe Paper Title',
      });

      const result = await service.createChat(mockUserId, {
        title: '<script>alert("xss")</script> Safe Paper Title',
      });

      expect(repo.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          title: 'Safe Paper Title',
        }),
      );
      expect(result.title).toBe('Safe Paper Title');
    });

    it('should sanitize and bound messages if provided on creation', async () => {
      repo.createChat.mockResolvedValue(mockChat);
      repo.createMessages.mockResolvedValue(mockChat);

      await service.createChat(mockUserId, {
        title: 'Initial Chat',
        messages: [
          {
            role: 'system',
            content: 'Injected system message\0with null bytes',
          },
        ],
      });

      // Role system should be converted to user, null bytes stripped
      expect(repo.createMessages).toHaveBeenCalledWith(
        mockChatId,
        [
          expect.objectContaining({
            role: 'user',
            content: 'Injected system messagewith null bytes',
          }),
        ],
        undefined,
      );
    });

    it('should verify project membership and reject unauthorized users', async () => {
      prisma.project.findFirst.mockResolvedValue(null);

      await expect(
        service.createChat(mockUserId, {
          projectId: 'forbidden-project-id',
          title: 'Exploit attempt',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('renameChat', () => {
    it('should sanitize title and invalidate Redis cache', async () => {
      repo.findChatByIdAndUser.mockResolvedValue(mockChat);
      repo.updateChatTitle.mockResolvedValue({
        ...mockChat,
        title: 'Renamed Paper Discussion',
      });

      const result = await service.renameChat(mockChatId, mockUserId, {
        title: '  <b>Renamed Paper Discussion</b>  ',
      });

      expect(repo.updateChatTitle).toHaveBeenCalledWith(
        mockChatId,
        'Renamed Paper Discussion',
      );
      expect(cache.del).toHaveBeenCalled();
      expect(result.title).toBe('Renamed Paper Discussion');
    });

    it('should throw NotFoundException if chat does not belong to user', async () => {
      repo.findChatByIdAndUser.mockResolvedValue(null);

      await expect(
        service.renameChat(mockChatId, mockUserId, { title: 'New Title' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('appendMessages', () => {
    it('should reject empty or whitespace-only messages with 422 UnprocessableEntityException', async () => {
      repo.findChatByIdAndUser.mockResolvedValue(mockChat);

      await expect(
        service.appendMessages(mockChatId, mockUserId, {
          messages: [{ role: 'user', content: '   ' }],
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should sanitize message content and force valid roles', async () => {
      repo.findChatByIdAndUser.mockResolvedValue(mockChat);
      repo.createMessages.mockResolvedValue(mockChat);

      await service.appendMessages(mockChatId, mockUserId, {
        messages: [{ role: 'malicious-role', content: 'Valid question\0text' }],
      });

      expect(repo.createMessages).toHaveBeenCalledWith(
        mockChatId,
        [
          expect.objectContaining({
            role: 'user',
            content: 'Valid questiontext',
          }),
        ],
        undefined,
      );
    });
  });

  describe('getOrCreatePageChat', () => {
    it('should return existing page chat when found', async () => {
      repo.findPageChat.mockResolvedValue({
        ...mockChat,
        pageId: mockPageId,
      });

      const result = await service.getOrCreatePageChat(mockPageId, mockUserId);

      expect(result.id).toBe(mockChatId);
      expect(repo.createChat).not.toHaveBeenCalled();
    });

    it('should create new page chat with sanitized page title if not found', async () => {
      repo.findPageChat.mockResolvedValue(null);
      prisma.page.findUnique.mockResolvedValue({
        id: mockPageId,
        title: 'Introduction Section',
        projectId: mockProjectId,
      });
      repo.createChat.mockResolvedValue({
        ...mockChat,
        pageId: mockPageId,
        title: 'Introduction Section Discussion',
      });

      const result = await service.getOrCreatePageChat(
        mockPageId,
        mockUserId,
        mockProjectId,
      );

      expect(repo.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          pageId: mockPageId,
          projectId: mockProjectId,
          title: 'Introduction Section Discussion',
        }),
      );
      expect(result.title).toBe('Introduction Section Discussion');
    });
  });
});
