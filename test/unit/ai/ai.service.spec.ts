import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import type { FastifyReply } from 'fastify';
import type { PrismaService } from '@/core';
import { AiFacade } from '@/modules/ai/ai.facade';
import { AccessRepository } from '@/modules/ai/access/access.repository';
import { AccessService } from '@/modules/ai/access/services/access.service';
import { DocumentAccessService } from '@/modules/ai/access/services/document.service';
import { SpaceAccessService } from '@/modules/ai/access/services/space.service';
import { ChatRepository } from '@/modules/ai/chat/chat.repository';
import { ChatService } from '@/modules/ai/chat/services/chat.service';
import { SessionService } from '@/modules/ai/chat/services/session.service';
import { TitleService } from '@/modules/ai/chat/services/title.service';
import type { IAiEnginePort } from '@/modules/ai/engine/engine.port';
import type { StreamCompletionResult } from '@/modules/ai/engine/types/engine.type';

interface MockChatRecord {
  id: string;
  createdById: string;
  spaceId: string;
  pageId?: string | null;
  title: string;
  documentIds: string[];
  messages: unknown[];
  space?: { projectId: string | null } | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockAiChatCreateArgs {
  data: {
    createdById?: string;
    spaceId?: string;
    pageId?: string;
    title?: string;
    documentIds?: string[];
  };
}

interface MockAiMessageCreateManyArgs {
  data: Array<{
    chatId: string;
    role: string;
    content: string;
    sources?: unknown[];
  }>;
}

describe('AI ChatService, SessionService & AiFacade Suite', () => {
  let chatService: ChatService;
  let sessionService: SessionService;
  let aiFacade: AiFacade;
  let mockEngine: jest.Mocked<IAiEnginePort>;
  let mockPrisma: {
    space: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    project: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    page: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    pageDoc: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    storageFile: {
      findMany: jest.Mock<Promise<unknown[]>, [unknown?]>;
      findFirst: jest.Mock<Promise<unknown>, [unknown?]>;
    };
    libraryItem: { findMany: jest.Mock<Promise<unknown[]>, [unknown?]> };
    aiChat: {
      findFirst: jest.Mock<Promise<MockChatRecord | null>, [unknown?]>;
      findUnique: jest.Mock<Promise<MockChatRecord | null>, [unknown?]>;
      findMany: jest.Mock<Promise<MockChatRecord[]>, [unknown?]>;
      create: jest.Mock<Promise<MockChatRecord>, [MockAiChatCreateArgs]>;
      update: jest.Mock<Promise<MockChatRecord>, [unknown?]>;
      delete: jest.Mock<Promise<{ id: string }>, [unknown?]>;
      deleteMany: jest.Mock<Promise<{ count: number }>, [unknown?]>;
    };
    aiMessage: {
      createMany: jest.Mock<
        Promise<{ count: number }>,
        [MockAiMessageCreateManyArgs]
      >;
    };
  };
  let mockReply: FastifyReply;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockChatId = '22222222-2222-2222-2222-222222222222';
  const mockProjectId = '33333333-3333-3333-3333-333333333333';
  const mockPageId = '44444444-4444-4444-4444-444444444444';
  const mockPersonalSpaceId = '55555555-5555-5555-5555-555555555555';

  const makeChatRecord = (
    overrides: Partial<MockChatRecord> = {},
  ): MockChatRecord => ({
    id: mockChatId,
    createdById: mockUserId,
    spaceId: mockUserId,
    title: 'Existing Chat',
    documentIds: [],
    messages: [],
    space: { projectId: null },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    mockEngine = {
      health: jest.fn().mockResolvedValue({
        status: 'ok',
        service: 'flux-ai',
        upstream: { status: 'ok' },
        timestamp: new Date().toISOString(),
      }),
      listAgents: jest.fn().mockResolvedValue([]),
      chatSync: jest.fn().mockResolvedValue({
        content: 'Authoritative AI response',
        route: 'rag_agent',
        status: 'completed',
        citations: [{ source_id: 'doc-1', title: 'Report', page: 1 }],
        sources: [{ source: 'doc-1 (p.1)', title: 'Report', page: 1 }],
        interrupts: [],
        usage: {},
        trace_id: 'trace-1',
      }),
      chatStream: jest.fn().mockResolvedValue(undefined),
      resumeSync: jest.fn().mockResolvedValue({
        content: 'Approved action result',
        route: 'project_agent',
        status: 'completed',
        citations: [],
        sources: [],
        interrupts: [],
        usage: {},
        trace_id: 'trace-resume',
      }),
      resumeStream: jest.fn().mockResolvedValue(undefined),
      cancelThread: jest.fn().mockResolvedValue(undefined),
      deleteThread: jest
        .fn()
        .mockResolvedValue({ space_id: mockUserId, deleted: true }),
      deleteSpaceThreads: jest.fn().mockResolvedValue({
        space_id: mockUserId,
        deleted: true,
        deleted_threads: 2,
      }),
      ingestDocument: jest.fn(),
      searchKnowledge: jest.fn(),
      deleteKnowledgeSource: jest.fn(),
      deleteSpaceKnowledge: jest.fn(),
    };

    const existingChat = makeChatRecord();

    mockPrisma = {
      space: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      project: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      page: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      pageDoc: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      storageFile: {
        findMany: jest.fn<Promise<unknown[]>, [unknown?]>(async () => []),
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      libraryItem: {
        findMany: jest.fn<Promise<unknown[]>, [unknown?]>(async () => []),
      },
      aiChat: {
        findFirst: jest.fn<Promise<MockChatRecord | null>, [unknown?]>(
          async () => existingChat,
        ),
        findUnique: jest.fn<Promise<MockChatRecord | null>, [unknown?]>(
          async () => existingChat,
        ),
        findMany: jest.fn<Promise<MockChatRecord[]>, [unknown?]>(
          async () => [],
        ),
        create: jest.fn<Promise<MockChatRecord>, [MockAiChatCreateArgs]>(
          async ({ data }) =>
            makeChatRecord({
              createdById: data.createdById ?? mockUserId,
              spaceId: data.spaceId ?? mockUserId,
              title: data.title ?? 'New Chat',
              documentIds: data.documentIds ?? [],
            }),
        ),
        update: jest.fn<Promise<MockChatRecord>, [unknown?]>(async () =>
          makeChatRecord({ title: 'Updated Chat' }),
        ),
        delete: jest.fn<Promise<{ id: string }>, [unknown?]>(async () => ({
          id: mockChatId,
        })),
        deleteMany: jest.fn<Promise<{ count: number }>, [unknown?]>(
          async () => ({
            count: 1,
          }),
        ),
      },
      aiMessage: {
        createMany: jest.fn<
          Promise<{ count: number }>,
          [MockAiMessageCreateManyArgs]
        >(async () => ({ count: 1 })),
      },
    };

    const prismaService = fromPartial<PrismaService>(mockPrisma);
    const accessRepo = new AccessRepository(prismaService);
    const spaceAccess = new SpaceAccessService(accessRepo);
    const docAccess = new DocumentAccessService(accessRepo, spaceAccess);
    const accessService = new AccessService(spaceAccess, docAccess);

    const chatRepo = new ChatRepository(prismaService);
    sessionService = new SessionService(
      chatRepo,
      spaceAccess,
      undefined,
      mockEngine,
    );
    const titleService = new TitleService(chatRepo, sessionService, mockEngine);
    chatService = new ChatService(
      mockEngine,
      accessService,
      sessionService,
      titleService,
    );
    aiFacade = new AiFacade(mockEngine, accessService);

    mockReply = fromPartial<FastifyReply>({
      raw: {
        writeHead: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      },
      hijack: jest.fn(),
    });
  });

  describe('stream & execute', () => {
    it('rejects empty query with 422 UnprocessableEntityException', async () => {
      await expect(
        chatService.stream(mockUserId, { query: '   ' }, mockReply),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('rejects unauthorized project access with 403 ForbiddenException', async () => {
      mockPrisma.project.findFirst.mockResolvedValue(null);

      await expect(
        chatService.stream(
          mockUserId,
          { spaceId: mockProjectId, query: 'Check project docs' },
          mockReply,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects chat owned by another user with 403 ForbiddenException', async () => {
      mockPrisma.aiChat.findFirst.mockResolvedValue(
        makeChatRecord({ createdById: 'other-user-id' }),
      );

      await expect(
        chatService.stream(
          mockUserId,
          { chatId: mockChatId, query: 'Inspect secret chat' },
          mockReply,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('auto-creates session, streams via engine, and persists BOTH content and sources on completion', async () => {
      type OnCompleteFn = (
        result: StreamCompletionResult,
      ) => Promise<void> | void;
      let capturedOnComplete: OnCompleteFn | undefined;
      mockEngine.chatStream.mockImplementation(
        async (_req, _reply, options) => {
          capturedOnComplete = options?.onComplete;
        },
      );

      const query = 'Summarize FluxKV memory reduction';
      await chatService.stream(
        mockUserId,
        { query, webSearchSites: ['arxiv.org'] },
        mockReply,
      );

      const createArgs = mockPrisma.aiChat.create.mock.calls[0]?.[0];
      expect(createArgs?.data.createdById).toBe(mockUserId);
      expect(createArgs?.data.title).toBe('Summarize FluxKV memory reduction');

      const [streamReq, streamReply, streamOpts] =
        mockEngine.chatStream.mock.calls[0];
      expect(streamReq.chat_id).toBe(mockChatId);
      expect(streamReq.space_id).toBe(mockUserId);
      expect(streamReq.context).toEqual(
        expect.objectContaining({ allowed_domains: ['arxiv.org'] }),
      );
      expect(streamReply).toBe(mockReply);
      expect(streamOpts?.initialFrames).toEqual([
        expect.stringContaining('[META]'),
      ]);

      expect(capturedOnComplete).toBeDefined();
      await capturedOnComplete!({
        content: 'FluxKV reduces VRAM by 63.8%.',
        route: 'rag_agent',
        citations: [{ source_id: 'fluxkv-2026', title: 'Report', page: 2 }],
        sources: [{ source: 'fluxkv-2026 (p.2)', title: 'Report', page: 2 }],
        interrupts: [],
        cancelled: false,
      });

      const msgCalls = mockPrisma.aiMessage.createMany.mock.calls;
      const lastMsgCall = msgCalls[msgCalls.length - 1]?.[0];
      expect(lastMsgCall?.data).toEqual([
        expect.objectContaining({
          chatId: mockChatId,
          role: 'assistant',
          content: 'FluxKV reduces VRAM by 63.8%.',
          sources: [{ source: 'fluxkv-2026 (p.2)', title: 'Report', page: 2 }],
        }),
      ]);
    });

    it('preserves existing chat title on follow-up turn without overwriting or re-generating title', async () => {
      mockPrisma.aiChat.findFirst.mockResolvedValue(
        makeChatRecord({ title: 'FluxKV Deep Dive' }),
      );

      type OnCompleteFn = (
        result: StreamCompletionResult,
      ) => Promise<void> | void;
      let capturedOnComplete: OnCompleteFn | undefined;
      mockEngine.chatStream.mockImplementation(
        async (_req, _reply, options) => {
          capturedOnComplete = options?.onComplete;
        },
      );

      await chatService.stream(
        mockUserId,
        {
          chatId: mockChatId,
          query: 'Follow-up question about eviction policy',
        },
        mockReply,
      );

      const [, , streamOpts] = mockEngine.chatStream.mock.calls[0];
      expect(streamOpts?.initialFrames).toEqual([
        `data: [META]${JSON.stringify({ chatId: mockChatId, title: 'FluxKV Deep Dive' })}\n\n`,
      ]);

      await capturedOnComplete!({
        content: 'LRU eviction is bounded.',
        route: 'direct',
        citations: [],
        sources: [],
        interrupts: [],
        cancelled: false,
      });

      expect(mockEngine.chatSync).not.toHaveBeenCalled();
      expect(mockPrisma.aiChat.create).not.toHaveBeenCalled();
    });

    it('skips persisting empty/cancelled stream responses and creates page chat when pageId supplied', async () => {
      mockPrisma.page.findFirst.mockResolvedValue({
        id: mockPageId,
        title: 'Introduction',
        spaceId: mockUserId,
      });

      const appendSpy = jest.spyOn(sessionService, 'appendMessages');
      type OnCompleteFn = (
        result: StreamCompletionResult,
      ) => Promise<void> | void;
      let capturedOnComplete: OnCompleteFn | undefined;
      mockEngine.chatStream.mockImplementation(
        async (_req, _reply, options) => {
          capturedOnComplete = options?.onComplete;
        },
      );

      await chatService.stream(
        mockUserId,
        { pageId: mockPageId, query: 'Polish paragraph' },
        mockReply,
      );

      await capturedOnComplete!({
        content: 'Partial cancelled text',
        route: 'direct',
        citations: [],
        sources: [],
        interrupts: [],
        cancelled: true,
      });

      expect(appendSpy).toHaveBeenCalledTimes(1);
    });

    it('executes synchronous chat, persists sources, and forwards cancel & HITL resume', async () => {
      const result = await chatService.execute(mockUserId, {
        chatId: mockChatId,
        query: 'Explain theorem',
      });

      expect(result.content).toBe('Authoritative AI response');
      expect(result.sources).toEqual([
        { source: 'doc-1 (p.1)', title: 'Report', page: 1 },
      ]);
      expect(result.chatId).toBe(mockChatId);
      expect(result.title).toBe('Existing Chat');

      await chatService.cancel(mockUserId, mockChatId);
      expect(mockEngine.cancelThread).toHaveBeenCalledWith(
        mockUserId,
        mockChatId,
      );

      const resumed = await chatService.resumeSync(mockUserId, {
        chatId: mockChatId,
        decision: { approved: true },
      });
      expect(resumed.content).toBe('Approved action result');
      expect(mockEngine.resumeSync).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: mockChatId,
          space_id: mockUserId,
          decision: { approved: true },
        }),
      );
    });
  });

  describe('Session lifecycle, Space projectId & AiFacade', () => {
    it('deletes Python AI checkpointer threads on deleteChat and clearMemory', async () => {
      await sessionService.deleteChat(mockChatId, mockUserId);
      expect(mockEngine.deleteThread).toHaveBeenCalledWith(
        mockUserId,
        mockChatId,
      );

      await sessionService.clearMemory(mockUserId);
      expect(mockEngine.deleteSpaceThreads).toHaveBeenCalledWith(mockUserId);
    });

    it('derives projectId strictly from space.projectId without guessing personal space UUIDs', async () => {
      mockPrisma.aiChat.findFirst.mockResolvedValueOnce(
        makeChatRecord({
          spaceId: mockPersonalSpaceId,
          space: { projectId: null },
        }),
      );
      const personalChat = await sessionService.getChat(mockChatId, mockUserId);
      expect(personalChat.spaceId).toBe(mockPersonalSpaceId);
      expect(personalChat.projectId).toBeNull();

      mockPrisma.aiChat.findFirst.mockResolvedValueOnce(
        makeChatRecord({
          spaceId: mockProjectId,
          space: { projectId: mockProjectId },
        }),
      );
      const projectChat = await sessionService.getChat(mockChatId, mockUserId);
      expect(projectChat.spaceId).toBe(mockProjectId);
      expect(projectChat.projectId).toBe(mockProjectId);
    });

    it('AiFacade.generate executes stateless direct call for CLSI helpers', async () => {
      const res = await aiFacade.generate({
        prompt: 'Fix LaTeX error',
        systemInstruction: 'You are a LaTeX helper',
        temperature: 0.2,
        userId: mockUserId,
        spaceId: mockUserId,
      });

      expect(res).toEqual({ text: 'Authoritative AI response' });
      expect(mockEngine.chatSync).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: mockUserId,
          stateless: true,
          intent_hint: 'direct',
          context: { temperature: 0.2 },
        }),
      );
    });
  });
});
