import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from '@/modules/ai/ai.service';
import { EngineService } from '@/modules/ai/engine/engine.service';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { PrismaService } from '@/core/database/prisma.service';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';

describe('AiService (Server-Authoritative Chat & Streaming)', () => {
  let service: AiService;
  let engineService: jest.Mocked<EngineService>;
  let threadService: jest.Mocked<ThreadService>;
  let prisma: any;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChatId = '22222222-2222-2222-2222-222222222222';
  const mockProjectId = '33333333-3333-3333-3333-333333333333';
  const mockPageId = '44444444-4444-4444-4444-444444444444';

  const mockReply = {
    raw: {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    },
    hijack: jest.fn(),
  } as unknown as FastifyReply;

  beforeEach(async () => {
    const mockEngine = {
      health: jest.fn().mockResolvedValue({ status: 'ok' }),
      streamChat: jest.fn().mockResolvedValue(undefined),
      syncChat: jest.fn().mockResolvedValue({
        role: 'assistant',
        content: 'Authoritative AI response',
        sources: [],
        widgets: [],
      }),
    };

    const mockThread = {
      createChat: jest.fn().mockResolvedValue({
        id: mockChatId,
        title: 'Quantum Computing Paper',
      }),
      getOrCreatePageChat: jest.fn().mockResolvedValue({
        id: mockChatId,
        title: 'Introduction Discussion',
      }),
      appendMessages: jest.fn().mockResolvedValue({}),
    };

    const mockPrisma = {
      project: {
        findFirst: jest.fn(),
      },
      page: {
        findFirst: jest.fn(),
      },
      aiChat: {
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: EngineService, useValue: mockEngine },
        { provide: ThreadService, useValue: mockThread },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
    engineService = module.get(EngineService);
    threadService = module.get(ThreadService);
    prisma = module.get(PrismaService);
  });

  describe('stream (SSE Chat Execution)', () => {
    it('should reject empty or whitespace query with 422 UnprocessableEntityException', async () => {
      await expect(
        service.stream(mockUserId, { query: '   ' }, mockReply),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should reject unauthorized project access with 403 ForbiddenException', async () => {
      prisma.project.findFirst.mockResolvedValue(null);

      await expect(
        service.stream(
          mockUserId,
          { projectId: mockProjectId, query: 'Valid query' },
          mockReply,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject unauthorized chat access if chat belongs to another user', async () => {
      prisma.aiChat.findFirst.mockResolvedValue({
        id: mockChatId,
        userId: 'other-user-uuid',
      });

      await expect(
        service.stream(
          mockUserId,
          { chatId: mockChatId, query: 'Valid query' },
          mockReply,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should auto-create chat session when chatId is missing and pass [META] event', async () => {
      const queryText = 'Explain quantum entanglement in physics';
      await service.stream(mockUserId, { query: queryText }, mockReply);

      // Verify thread creation with sanitized title from query
      expect(threadService.createChat).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({
          title: 'Explain quantum entanglement in physics',
        }),
      );

      // Verify user message persisted to database
      expect(threadService.appendMessages).toHaveBeenCalledWith(
        mockChatId,
        mockUserId,
        expect.objectContaining({
          messages: [{ role: 'user', content: queryText }],
        }),
      );

      // Verify engineService streamChat called with initial [META] event
      expect(engineService.streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: mockChatId,
        }),
        mockReply,
        expect.objectContaining({
          initialEvents: [expect.stringContaining('[META]')],
        }),
      );
    });

    it('should resolve or create pageChat when pageId is provided', async () => {
      prisma.page.findFirst.mockResolvedValue({
        id: mockPageId,
        authorId: mockUserId,
      });

      await service.stream(
        mockUserId,
        { pageId: mockPageId, query: 'Suggest improvements to this section' },
        mockReply,
      );

      expect(threadService.getOrCreatePageChat).toHaveBeenCalledWith(
        mockPageId,
        mockUserId,
        undefined,
      );
      expect(engineService.streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: mockChatId,
        }),
        mockReply,
        expect.any(Object),
      );
    });

    it('should persist assistant message upon stream completion callback', async () => {
      let capturedOnComplete: ((text: string) => Promise<void>) | undefined;
      engineService.streamChat.mockImplementation(
        async (payload: any, reply: any, options?: any) => {
          capturedOnComplete = options?.onComplete;
        },
      );

      await service.stream(
        mockUserId,
        { chatId: mockChatId, query: 'Summarize paper' },
        mockReply,
      );

      expect(capturedOnComplete).toBeDefined();

      // Trigger the onComplete stream hook
      await capturedOnComplete!('This is the completed assistant summary.');

      expect(threadService.appendMessages).toHaveBeenCalledWith(
        mockChatId,
        mockUserId,
        expect.objectContaining({
          messages: [
            {
              role: 'assistant',
              content: 'This is the completed assistant summary.',
            },
          ],
        }),
      );
    });
  });

  describe('execute (Synchronous Chat)', () => {
    it('should reject empty message with 422 UnprocessableEntityException', async () => {
      await expect(
        service.execute(mockUserId, {
          messages: [{ role: 'user', content: '' }],
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should execute synchronous chat, save both user and assistant messages, and return result with chatId', async () => {
      const result = await service.execute(mockUserId, {
        chatId: mockChatId,
        query: 'What is the theorem statement?',
      });

      // Saved user message
      expect(threadService.appendMessages).toHaveBeenCalledWith(
        mockChatId,
        mockUserId,
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'What is the theorem statement?' },
          ],
        }),
      );

      // Saved assistant message
      expect(threadService.appendMessages).toHaveBeenCalledWith(
        mockChatId,
        mockUserId,
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              role: 'assistant',
              content: 'Authoritative AI response',
            }),
          ],
        }),
      );

      expect(result.chatId).toBe(mockChatId);
      expect(result.content).toBe('Authoritative AI response');
    });
  });
});
