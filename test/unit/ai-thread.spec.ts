import { Test, TestingModule } from '@nestjs/testing';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { ThreadRepository } from '@/modules/ai/thread/thread.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { MessageRole } from '@prisma/client';

describe('ThreadService & ThreadRepository (Two-Tier Zero-Workspace Architecture)', () => {
  let service: ThreadService;
  let repo: ThreadRepository;
  let prisma: any;
  let cache: any;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockOtherUserId = '22222222-2222-2222-2222-222222222222';
  const mockProjectId = '33333333-3333-3333-3333-333333333333';
  const mockPageId = '44444444-4444-4444-4444-444444444444';
  const mockChatId = '55555555-5555-5555-5555-555555555555';

  const mockChatEntity = {
    id: mockChatId,
    userId: mockUserId,
    projectId: null,
    pageId: null,
    title: 'Personal Research Chat',
    summary: '',
    keyFacts: [],
    openQuestions: [],
    documentIds: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T01:00:00Z'),
    messages: [
      {
        id: 'msg-1',
        chatId: mockChatId,
        role: MessageRole.user,
        content: 'Hello Copilot',
        sources: [],
        widgets: [],
        selectionContext: null,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      },
      {
        id: 'msg-2',
        chatId: mockChatId,
        role: MessageRole.assistant,
        content: 'Hello researcher, how can I assist with your study?',
        sources: [],
        widgets: [],
        selectionContext: null,
        createdAt: new Date('2026-09-01T00:00:01Z'),
      },
    ],
  };

  beforeEach(async () => {
    prisma = {
      aiChat: {
        findMany: jest.fn().mockResolvedValue([mockChatEntity]),
        findUnique: jest.fn().mockResolvedValue(mockChatEntity),
        findFirst: jest.fn().mockResolvedValue(mockChatEntity),
        create: jest.fn().mockResolvedValue(mockChatEntity),
        update: jest.fn().mockResolvedValue(mockChatEntity),
        delete: jest.fn().mockResolvedValue(mockChatEntity),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      aiMessage: {
        create: jest.fn().mockResolvedValue(mockChatEntity.messages[0]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      project: {
        findFirst: jest.fn(),
      },
      page: {
        findFirst: jest.fn(),
      },
    };

    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThreadService,
        ThreadRepository,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisCacheService, useValue: cache },
      ],
    }).compile();

    service = module.get<ThreadService>(ThreadService);
    repo = module.get<ThreadRepository>(ThreadRepository);
  });

  describe('Personal Scope (Tier 1)', () => {
    it('should retrieve personal chats without projectId and populate Redis cache', async () => {
      const chats = await service.getChats(mockUserId);
      expect(chats).toHaveLength(1);
      expect(chats[0].id).toBe(mockChatId);
      expect(chats[0].title).toBe('Personal Research Chat');
      expect(chats[0].messageCount).toBe(2);
      expect(chats[0].lastMessage).toBe(
        'Hello researcher, how can I assist with your study?',
      );
      expect(chats[0].scopeSlug).toBe(mockUserId);

      // Verify Redis cache set
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(prisma.aiChat.findMany).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
      });
    });

    it('should return cached personal chats when available in Redis', async () => {
      cache.get.mockResolvedValueOnce([mockChatEntity]);
      const chats = await service.getChats(mockUserId);
      expect(chats).toHaveLength(1);
      expect(prisma.aiChat.findMany).not.toHaveBeenCalled();
    });

    it('should create a personal chat session and invalidate cache', async () => {
      const result = await service.createChat(mockUserId, {
        title: 'New Literature Review',
      });
      expect(result.id).toBe(mockChatId);
      expect(cache.del).toHaveBeenCalled();
      expect(prisma.aiChat.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUserId,
          title: 'New Literature Review',
        }),
        include: { messages: true },
      });
    });

    it('should append initial messages when creating chat with messages', async () => {
      const result = await service.createChat(mockUserId, {
        title: 'Chat with messages',
        messages: [{ role: 'user', content: 'What is quantum computing?' }],
      });
      expect(result).toBeDefined();
      expect(prisma.aiMessage.createMany).toHaveBeenCalled();
    });

    it('should get chat by id for authorized user', async () => {
      const chat = await service.getChat(mockChatId, mockUserId);
      expect(chat.id).toBe(mockChatId);
      expect(prisma.aiChat.findFirst).toHaveBeenCalledWith({
        where: { id: mockChatId, userId: mockUserId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
    });

    it('should throw NotFoundException if chat not found or user is unauthorized', async () => {
      prisma.aiChat.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.getChat(mockChatId, mockOtherUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should append message to chat and invalidate Redis cache', async () => {
      const updated = await service.appendMessages(mockChatId, mockUserId, {
        messages: [{ role: 'user', content: 'Follow up question' }],
      });
      expect(updated).toBeDefined();
      expect(prisma.aiMessage.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            chatId: mockChatId,
            role: MessageRole.user,
            content: 'Follow up question',
          }),
        ],
      });
      expect(cache.del).toHaveBeenCalled();
    });

    it('should rename chat title and invalidate cache', async () => {
      const renamed = await service.renameChat(mockChatId, mockUserId, {
        title: 'Renamed Chat Title',
      });
      expect(renamed).toBeDefined();
      expect(prisma.aiChat.update).toHaveBeenCalledWith({
        where: { id: mockChatId },
        data: { title: 'Renamed Chat Title' },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
      expect(cache.del).toHaveBeenCalled();
    });

    it('should delete personal chat and invalidate cache', async () => {
      const result = await service.deleteChat(mockChatId, mockUserId);
      expect(result).toEqual({ success: true });
      expect(prisma.aiChat.delete).toHaveBeenCalledWith({
        where: { id: mockChatId },
      });
      expect(cache.del).toHaveBeenCalled();
    });

    it('should clear personal memory for user', async () => {
      const result = await service.clearMemory(mockUserId);
      expect(result).toEqual({ success: true });
      expect(prisma.aiChat.deleteMany).toHaveBeenCalledWith({
        where: { userId: mockUserId, projectId: null },
      });
    });

    it('should clear project memory when projectId is specified', async () => {
      const result = await service.clearMemory(mockUserId, mockProjectId);
      expect(result).toEqual({ success: true });
      expect(prisma.aiChat.deleteMany).toHaveBeenCalledWith({
        where: { userId: mockUserId, projectId: mockProjectId },
      });
    });
  });

  describe('Project Scope (Tier 2 Collaborative)', () => {
    it('should check project access when listing chats with projectId', async () => {
      prisma.project.findFirst.mockResolvedValueOnce({ id: mockProjectId });
      await service.getChats(mockUserId, mockProjectId);

      expect(prisma.project.findFirst).toHaveBeenCalledWith({
        where: {
          id: mockProjectId,
          deletedAt: null,
          OR: [
            { createdById: mockUserId },
            { members: { some: { userId: mockUserId } } },
          ],
        },
        select: { id: true },
      });
      expect(prisma.aiChat.findMany).toHaveBeenCalledWith({
        where: { userId: mockUserId, projectId: mockProjectId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
      });
    });

    it('should throw ForbiddenException if user has no access to project when listing chats', async () => {
      prisma.project.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.getChats(mockUserId, mockProjectId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create project-scoped chat for verified member', async () => {
      prisma.project.findFirst.mockResolvedValueOnce({
        id: mockProjectId,
        identifier: 'RES',
      });

      const result = await service.createChat(mockUserId, {
        projectId: mockProjectId,
        title: 'Project Brainstorming',
      });
      expect(result).toBeDefined();
      expect(prisma.aiChat.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUserId,
          projectId: mockProjectId,
          title: 'Project Brainstorming',
        }),
        include: { messages: true },
      });
    });

    it('should throw ForbiddenException if user tries to create chat in non-accessible project', async () => {
      prisma.project.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.createChat(mockUserId, {
          projectId: mockProjectId,
          title: 'Unauthorized Chat',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Page Scope (Document-Level Copilot)', () => {
    it('should retrieve active page chat', async () => {
      prisma.aiChat.findFirst.mockResolvedValueOnce(mockChatEntity);
      const result = await service.getPageChat(mockPageId, mockUserId);
      expect(result.chat?.id).toBe(mockChatId);
      expect(result.messages).toHaveLength(2);
      expect(prisma.aiChat.findFirst).toHaveBeenCalledWith({
        where: { pageId: mockPageId, userId: mockUserId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
      });
    });

    it('should throw BadRequestException if pageId is missing in getPageChat', async () => {
      await expect(service.getPageChat('', mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should clear page chat and invalidate cache', async () => {
      prisma.aiChat.findFirst.mockResolvedValueOnce(mockChatEntity);
      const result = await service.clearPageChat(mockPageId, mockUserId);
      expect(result).toEqual({ success: true });
      expect(prisma.aiChat.delete).toHaveBeenCalledWith({
        where: { id: mockChatId },
      });
      expect(cache.del).toHaveBeenCalled();
    });

    it('should verify page access when creating page-scoped chat', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({
        id: mockPageId,
        authorId: mockUserId,
        project: null,
      });

      await service.createChat(mockUserId, {
        pageId: mockPageId,
        title: 'Page Notes Discussion',
      });

      expect(prisma.page.findFirst).toHaveBeenCalled();
      expect(prisma.aiChat.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pageId: mockPageId,
          userId: mockUserId,
        }),
        include: { messages: true },
      });
    });

    it('should reject page-scoped chat creation if user has no access to page', async () => {
      prisma.page.findFirst.mockResolvedValueOnce({
        id: mockPageId,
        authorId: mockOtherUserId,
        project: {
          createdById: mockOtherUserId,
          members: [],
        },
      });

      await expect(
        service.createChat(mockUserId, {
          pageId: mockPageId,
          title: 'Unauthorized Page Chat',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
