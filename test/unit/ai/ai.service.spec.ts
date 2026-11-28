import {
  ForbiddenException,
  NotFoundException,
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
import { normalizeIntentHint } from '@/modules/ai/chat/domain/context.mapper';
import { SessionController } from '@/modules/ai/chat/controllers/session.controller';
import { ChatService } from '@/modules/ai/chat/services/chat.service';
import { PaperChatService } from '@/modules/ai/chat/services/paper.service';
import { SessionService } from '@/modules/ai/chat/services/session.service';
import { TitleService } from '@/modules/ai/chat/services/title.service';
import type { IAiEnginePort } from '@/modules/ai/engine/engine.port';
import type { StreamCompletionResult } from '@/modules/ai/engine/types/engine.type';
import {
  mergeAndEncryptEditorConfig,
  resolveDecryptedLlmOverride,
  sanitizeEditorConfigForClient,
} from '@/modules/identity/user/utils/user.util';

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
    widgets?: unknown[];
  }>;
}

describe('AI ChatService, SessionService, DocumentAccess & AiFacade Suite', () => {
  let chatService: ChatService;
  let sessionService: SessionService;
  let documentAccess: DocumentAccessService;
  let aiFacade: AiFacade;
  let mockEngine: jest.Mocked<IAiEnginePort>;
  let mockPrisma: {
    space: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    project: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    page: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    pageDoc: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    fileNode: {
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
      findMany: jest.Mock<Promise<unknown[]>, [unknown?]>;
      count: jest.Mock<Promise<number>, [unknown?]>;
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
      listModels: jest.fn().mockResolvedValue([]),
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
      revertTurn: jest.fn().mockResolvedValue({
        trace_id: 'trace-1',
        space_id: mockUserId,
        reverted_count: 0,
        results: [],
      }),
      listThreadCheckpoints: jest.fn().mockResolvedValue({
        chat_id: 'chat-1',
        space_id: mockUserId,
        checkpoints: [],
      }),
      rewindThread: jest.fn().mockResolvedValue({
        chat_id: 'chat-1',
        space_id: mockUserId,
        target_checkpoint_id: 'ckpt-1',
        new_checkpoint_id: 'ckpt-2',
        message_count: 2,
        reverted_count: 0,
        revert_results: [],
      }),
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
      fileNode: {
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
              pageId: data.pageId ?? null,
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
        findMany: jest.fn<Promise<unknown[]>, [unknown?]>(async () => []),
        count: jest.fn<Promise<number>, [unknown?]>(async () => 0),
        createMany: jest.fn<
          Promise<{ count: number }>,
          [MockAiMessageCreateManyArgs]
        >(async () => ({ count: 1 })),
      },
    };

    const prismaService = fromPartial<PrismaService>(mockPrisma);
    const accessRepo = new AccessRepository(prismaService);
    const spaceAccess = new SpaceAccessService(accessRepo);
    documentAccess = new DocumentAccessService(accessRepo, spaceAccess);
    const accessService = new AccessService(
      spaceAccess,
      documentAccess,
      accessRepo,
    );

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

    it('auto-creates session, streams via engine, and persists content and sources on completion', async () => {
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
        expect.stringContaining('"type":"meta"'),
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
        `data: ${JSON.stringify({ type: 'meta', chatId: mockChatId, title: 'FluxKV Deep Dive' })}\n\n`,
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

    it('skips persisting cancelled stream responses while persisting user message in page-scoped chat', async () => {
      mockPrisma.page.findFirst.mockResolvedValue({
        id: mockPageId,
        title: 'Introduction',
        spaceId: mockUserId,
      });

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

      expect(mockPrisma.aiMessage.createMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.aiMessage.createMany.mock.calls[0]?.[0]?.data[0]?.role).toBe(
        'user',
      );
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

    it('reuses existing global chatId when both chatId and pageId are supplied, and creates page-linked sessions for new editor chats', async () => {
      mockPrisma.page.findFirst.mockResolvedValue({
        id: mockPageId,
        title: 'Introduction',
        spaceId: mockUserId,
      });
      mockPrisma.aiChat.findFirst.mockResolvedValueOnce(
        makeChatRecord({ id: mockChatId, title: 'Global Research Thread' }),
      );

      await chatService.stream(
        mockUserId,
        {
          chatId: mockChatId,
          pageId: mockPageId,
          query: 'Continue global chat in editor',
        },
        mockReply,
      );

      expect(mockPrisma.aiChat.create).not.toHaveBeenCalled();
      expect(mockEngine.chatStream).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chat_id: mockChatId,
          page_id: mockPageId,
        }),
        mockReply,
        expect.any(Object),
      );

      await chatService.stream(
        mockUserId,
        {
          pageId: mockPageId,
          query: 'Fresh editor chat session',
        },
        mockReply,
      );

      expect(mockPrisma.aiChat.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.aiChat.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            createdById: mockUserId,
            spaceId: mockUserId,
            pageId: mockPageId,
            title: 'Fresh editor chat session',
          }),
        }),
      );
    });

    it('resolves both direct documentIds and attached_sources into RAG document IDs and enriched source metadata', async () => {
      mockPrisma.fileNode.findMany.mockImplementation(async (rawArgs) => {
        const ids =
          (rawArgs as { where?: { id?: { in?: string[] } } } | undefined)?.where
            ?.id?.in ?? [];
        const rows: Array<{ id: string; metadata: unknown }> = [];
        if (ids.includes('file-direct-1')) {
          rows.push({
            id: 'file-direct-1',
            metadata: { ragDocId: 'rag-direct-1' },
          });
        }
        if (ids.includes('file-att-2')) {
          rows.push({
            id: 'file-att-2',
            metadata: { ragDocId: 'rag-att-2' },
          });
        }
        return rows;
      });

      mockPrisma.libraryItem.findMany.mockResolvedValue([
        {
          id: 'item-1',
          title: 'Attention Is All You Need',
          metadata: { ragDocId: 'rag-item-1' },
          attachments: [
            {
              fileId: 'file-att-1',
              attachmentType: 'primary_pdf',
              metadata: null,
            },
          ],
        },
        {
          id: 'item-2',
          title: 'Deep Residual Learning',
          metadata: null,
          attachments: [
            {
              fileId: 'file-att-2',
              attachmentType: 'primary_pdf',
              metadata: null,
            },
          ],
        },
      ]);

      await chatService.execute(mockUserId, {
        chatId: mockChatId,
        query: 'Compare these papers',
        documentIds: ['file-direct-1', 'item-1'],
        context: {
          attached_sources: [
            { kind: 'paper', item_id: 'item-1' },
            { kind: 'library', item_id: 'item-2' },
          ],
        },
      });

      const sentRequest = mockEngine.chatSync.mock.calls[0]?.[0];
      expect(sentRequest?.document_ids).toEqual(
        expect.arrayContaining(['rag-direct-1', 'rag-item-1', 'rag-att-2']),
      );
      expect(sentRequest?.context?.attached_sources).toEqual([
        {
          kind: 'paper',
          title: 'Attention Is All You Need',
          source_id: 'rag-item-1',
          source_type: 'file',
          item_id: 'item-1',
          file_id: 'file-att-1',
          has_pdf: true,
          indexed: true,
        },
        {
          kind: 'library',
          title: 'Deep Residual Learning',
          source_id: 'rag-att-2',
          source_type: 'file',
          item_id: 'item-2',
          file_id: 'file-att-2',
          has_pdf: true,
          indexed: true,
        },
      ]);

      await expect(
        documentAccess.resolveChatDocuments([], undefined),
      ).resolves.toEqual({
        resolvedDocumentIds: [],
        enrichedSources: [],
      });
    });
  });

  describe('Session lifecycle, Pagination, Space projectId & AiFacade', () => {
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

    it('paginates chat messages, clamps skip/limit bounds, and rejects unauthorized chat owners', async () => {
      const msgCreatedAt = new Date('2026-03-01T10:00:00.000Z');
      mockPrisma.aiMessage.findMany.mockResolvedValue([
        {
          id: 'msg-3',
          chatId: mockChatId,
          role: 'user',
          content: 'Question 2',
          sources: [{ title: 'Paper A' }],
          widgets: [],
          createdAt: msgCreatedAt,
        },
        {
          id: 'msg-4',
          chatId: mockChatId,
          role: 'assistant',
          content: 'Answer 2',
          sources: [{ source: 'doc-1', title: 'Paper A' }],
          widgets: [],
          createdAt: msgCreatedAt,
        },
      ]);
      mockPrisma.aiMessage.count.mockResolvedValue(42);

      const controller = new SessionController(sessionService);
      const result = await controller.getChatMessages(
        mockChatId,
        mockUserId,
        20,
        10,
      );

      expect(result).toEqual({
        total: 42,
        messages: [
          {
            id: 'msg-3',
            role: 'user',
            content: 'Question 2',
            sources: undefined,
            attachments: [{ title: 'Paper A' }],
            widgets: [],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
          {
            id: 'msg-4',
            role: 'assistant',
            content: 'Answer 2',
            sources: [{ source: 'doc-1', title: 'Paper A' }],
            attachments: undefined,
            widgets: [],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
        ],
      });

      await sessionService.getChatMessages(mockChatId, mockUserId, {
        limit: 999,
        skip: -5,
      });
      expect(mockPrisma.aiMessage.findMany).toHaveBeenLastCalledWith({
        where: { chatId: mockChatId },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 200,
      });

      mockPrisma.aiChat.findFirst.mockResolvedValueOnce(null);
      await expect(
        sessionService.getChatMessages(mockChatId, mockUserId, {
          limit: 10,
          skip: 0,
        }),
      ).rejects.toThrow(NotFoundException);
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

  describe('Intent routing, Widgets persistence, PaperChat & BYOK', () => {
    it('routes editor_agent and latex intent hints cleanly while falling back when docs/domains attached', () => {
      expect(normalizeIntentHint('editor_agent', false, false)).toBe(
        'editor_agent',
      );
      expect(normalizeIntentHint('editor', true, true)).toBe('editor_agent');
      expect(normalizeIntentHint('latex', false, false)).toBe('editor_agent');
      expect(normalizeIntentHint('latex', true, false)).toBeNull();
    });

    it('persists editor_patches widgets on stream completion', async () => {
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
          query: 'Fix brace mismatch',
          intentHint: 'editor_agent',
        },
        mockReply,
      );

      const widgetPayload = [
        {
          type: 'editor_patches',
          title: 'Proposed LaTeX Edit',
          patches: [
            {
              id: 'p1',
              filePath: 'main.tex',
              title: 'Close brace',
              searchText: '\\section{Intro',
              replaceText: '\\section{Intro}',
            },
          ],
        },
      ];

      await capturedOnComplete!({
        content: 'Closed missing brace on line 4.',
        route: 'editor_agent',
        citations: [],
        sources: [],
        widgets: widgetPayload,
        interrupts: [],
        cancelled: false,
      });

      const msgCalls = mockPrisma.aiMessage.createMany.mock.calls;
      const lastMsgCall = msgCalls[msgCalls.length - 1]?.[0];
      expect(lastMsgCall?.data).toEqual([
        expect.objectContaining({
          chatId: mockChatId,
          role: 'assistant',
          content: 'Closed missing brace on line 4.',
          widgets: widgetPayload,
        }),
      ]);
    });

    it('forwards resolved projectId to engine context for project_agent', async () => {
      mockPrisma.space.findFirst.mockResolvedValue({
        id: 'space-proj-1',
        type: 'project',
        ownerUserId: null,
        projectId: mockProjectId,
      });
      mockPrisma.project.findFirst.mockResolvedValue({
        id: mockProjectId,
        space: { id: 'space-proj-1' },
      });

      await chatService.execute(mockUserId, {
        spaceId: mockProjectId,
        query: 'Show overdue tasks',
        intentHint: 'project',
      });

      const chatSyncCalls = mockEngine.chatSync.mock.calls;
      const sentReq = chatSyncCalls[chatSyncCalls.length - 1]?.[0];
      expect(sentReq?.intent_hint).toBe('project_agent');
      expect(sentReq?.context?.project_id).toBe(mockProjectId);
    });

    it('encrypts BYOK API key at rest, masks client view, and decrypts llm_override for AI Engine', () => {
      const stored = mergeAndEncryptEditorConfig(
        { vimMode: true },
        {
          aiByok: {
            enabled: true,
            provider: 'openrouter',
            model: 'anthropic/claude-3.7-sonnet',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'sk-or-v1-secret987654321',
          },
        },
      ) as Record<string, unknown>;

      const storedByok = stored.aiByok as Record<string, unknown>;
      expect(storedByok.encryptedApiKey).toBeDefined();
      expect(storedByok.encryptedApiKey).not.toContain('secret987654321');
      expect(storedByok.apiKeyHint).toBe('sk-o••••4321');

      const clientSafe = sanitizeEditorConfigForClient(
        stored as unknown as Parameters<
          typeof sanitizeEditorConfigForClient
        >[0],
      ) as Record<string, unknown>;
      expect(clientSafe.aiByok).toEqual({
        enabled: true,
        provider: 'openrouter',
        model: 'anthropic/claude-3.7-sonnet',
        baseUrl: 'https://openrouter.ai/api/v1',
        hasApiKey: true,
        apiKeyHint: 'sk-o••••4321',
      });

      const resolved = resolveDecryptedLlmOverride(stored);
      expect(resolved).toEqual({
        api_key: 'sk-or-v1-secret987654321',
        model: 'anthropic/claude-3.7-sonnet',
        base_url: 'https://openrouter.ai/api/v1',
      });
    });

    it('PaperChatService delegates to ChatService so paper chats persist sessions, META, and messages', async () => {
      const resolvePaperTarget = jest.fn().mockResolvedValue({
        spaceId: mockUserId,
        title: 'Adam: A Method for Stochastic Optimization',
        authors: ['Diederik P. Kingma', 'Jimmy Ba'],
        year: 2015,
        doi: '10.48550/arXiv.1412.6980',
        abstract:
          'We introduce Adam, an algorithm for first-order gradient-based optimization.',
        itemId: 'paper-adam-1',
        fileId: 'file-adam-1',
        ragDocId: 'file-adam-1',
      });
      const paperChatService = new PaperChatService(
        chatService,
        fromPartial({
          resolvePaperTarget,
        }),
      );

      await paperChatService.stream(
        mockUserId,
        'paper-adam-1',
        { query: 'tóm tắt tài liệu' },
        mockReply,
      );

      expect(resolvePaperTarget).toHaveBeenCalledWith(
        mockUserId,
        'paper-adam-1',
      );
      expect(mockPrisma.aiChat.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Adam: A Method for Stochastic Optimization',
          }),
        }),
      );
      const streamCalls = mockEngine.chatStream.mock.calls;
      const lastCall = streamCalls[streamCalls.length - 1];
      const sentReq = lastCall?.[0];
      const streamOpts = lastCall?.[2];

      expect(sentReq?.messages?.[0]?.role).toBe('system');
      expect(sentReq?.messages?.[0]?.content).toContain(
        'Adam: A Method for Stochastic Optimization',
      );
      expect(streamOpts?.initialFrames?.[0]).toContain('"type":"meta"');
      expect(typeof streamOpts?.onComplete).toBe('function');
    });
  });
});
