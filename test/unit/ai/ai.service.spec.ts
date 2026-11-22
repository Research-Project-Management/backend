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
import { normalizeIntentHint } from '@/modules/ai/chat/domain/context.mapper';
import {
  mapArtifactsToWidgets,
  mapCitationToSourceItem,
  normalizeRawCitations,
  translateEngineSseFrame,
} from '@/modules/ai/engine/domain/stream.mapper';
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
      revertTurn: jest.fn().mockResolvedValue({
        trace_id: 'trace-1',
        space_id: mockUserId,
        reverted_count: 0,
        results: [],
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

    it('reuses existing global chatId when both chatId and pageId are supplied, and creates distinct page-linked sessions for new editor chats', async () => {
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

      // Starting a new chat in editor (pageId present, no chatId) creates a new session with pageId metadata
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

  describe('stream.mapper citation index preservation', () => {
    it('preserves positive integer index and drops zero/non-integer values', () => {
      const normalized = normalizeRawCitations([
        {
          index: 6,
          source_id: 'doc-resnet',
          title: 'ResNet',
          page: 6,
          snippet: 'CIFAR-10 results',
        },
        {
          index: 0,
          source_id: 'doc-invalid-zero',
          title: 'Zero Index',
        },
        {
          index: 1.5,
          source_id: 'doc-float',
          title: 'Float Index',
        },
      ]);

      expect(normalized).toHaveLength(3);
      expect(normalized[0].index).toBe(6);
      expect(normalized[1].index).toBeUndefined();
      expect(normalized[2].index).toBeUndefined();

      const mapped0 = mapCitationToSourceItem(normalized[0]);
      const mapped1 = mapCitationToSourceItem(normalized[1]);
      expect(mapped0.index).toBe(6);
      expect(mapped0.page).toBe(6);
      expect(mapped1.index).toBeUndefined();
    });
  });

  describe('editor_agent intent routing, widgets mapping, and persistence', () => {
    it('routes editor_agent and latex intent hints cleanly while falling back when docs/domains attached', () => {
      expect(normalizeIntentHint('editor_agent', false, false)).toBe(
        'editor_agent',
      );
      expect(normalizeIntentHint('editor', true, true)).toBe('editor_agent');
      expect(normalizeIntentHint('latex', false, false)).toBe('editor_agent');
      expect(normalizeIntentHint('latex', true, false)).toBeNull();
    });

    it('maps artifacts.editor_patches into editor_patches widget and forwards via run.finished [META]', () => {
      const widgets = mapArtifactsToWidgets({
        editor_patches: [
          {
            id: 'patch-1',
            file_id: 'doc-1',
            file_path: 'sections/intro.tex',
            kind: 'replace',
            title: 'Polish intro sentence',
            rationale: 'More concise academic phrasing',
            search_text: 'Old line',
            replace_text: 'New line',
            from_line: 10,
            to_line: 10,
            match_strategy: 'exact',
            warnings: ['Verify cite key'],
          },
        ],
      });

      expect(widgets).toEqual([
        {
          type: 'editor_patches',
          title: 'Proposed LaTeX Edit',
          patches: [
            {
              id: 'patch-1',
              fileId: 'doc-1',
              filePath: 'sections/intro.tex',
              kind: 'replace',
              title: 'Polish intro sentence',
              rationale: 'More concise academic phrasing',
              searchText: 'Old line',
              replaceText: 'New line',
              fromLine: 10,
              toLine: 10,
              matchStrategy: 'exact',
              warnings: ['Verify cite key'],
            },
          ],
        },
      ]);

      const translated = translateEngineSseFrame(
        'run.finished',
        JSON.stringify({
          route: 'editor_agent',
          citations: [],
          artifacts: {
            editor_patches: [
              {
                id: 'patch-1',
                file_path: 'main.tex',
                title: 'Fix typo',
                search_text: 'teh',
                replace_text: 'the',
                from_line: 4,
                to_line: 4,
              },
            ],
          },
        }),
      );

      expect(translated.widgets).toHaveLength(1);
      expect(translated.clientFrames[0]).toContain('[META]');
      expect(translated.clientFrames[0]).toContain('editor_patches');
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

    it('translates editor.patch_preview and error status on tool.completed cleanly', () => {
      const previewTranslated = translateEngineSseFrame(
        'editor.patch_preview',
        JSON.stringify({
          agent: 'editor_agent',
          total_patches: 2,
          patch: {
            id: 'patch-live-1',
            file_id: 'doc-method',
            file_path: 'sections/method.tex',
            kind: 'replace',
            title: 'Tighten method claim',
            search_text: 'We study FluxKV.',
            replace_text: 'We analyze FluxKV.',
            from_line: 5,
            to_line: 5,
            match_strategy: 'exact',
          },
        }),
      );

      expect(previewTranslated.finished).toBeUndefined();
      expect(previewTranslated.widgets).toBeUndefined();
      expect(previewTranslated.clientFrames).toHaveLength(1);
      expect(previewTranslated.clientFrames[0]).toContain('[ACTION]');
      const actionJson: unknown = JSON.parse(
        previewTranslated.clientFrames[0]
          .replace(/^data: \[ACTION\]/, '')
          .trim(),
      );
      expect(actionJson).toMatchObject({
        type: 'editor_patch_preview',
        agent: 'editor_agent',
        totalPatches: 2,
        patch: {
          id: 'patch-live-1',
          fileId: 'doc-method',
          filePath: 'sections/method.tex',
          kind: 'replace',
          title: 'Tighten method claim',
          searchText: 'We study FluxKV.',
          replaceText: 'We analyze FluxKV.',
          fromLine: 5,
          toLine: 5,
          matchStrategy: 'exact',
        },
      });

      const toolErr = translateEngineSseFrame(
        'tool.completed',
        JSON.stringify({
          tool: 'propose_edit',
          agent: 'editor_agent',
          status: 'error',
        }),
      );
      expect(toolErr.clientFrames[0]).toContain('"status":"error"');
      expect(toolErr.clientFrames[0]).toContain('"success":false');
    });

    it('forwards resolved projectId to engine context and maps artifacts.widgets for project_agent', async () => {
      mockPrisma.space.findFirst.mockResolvedValue({
        id: 'space-proj-1',
        type: 'project',
        ownerUserId: null,
        projectId: mockProjectId,
      });
      mockPrisma.project.findFirst.mockResolvedValue({
        id: mockProjectId,
        spaceId: 'space-proj-1',
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

      const widgets = mapArtifactsToWidgets({
        widgets: [
          {
            type: 'work_item_overview',
            title: 'Project Work Items Overview',
            total: 2,
            done: 1,
            inProgress: 1,
            overdue: 1,
            groups: [],
          },
          {
            type: 'metric_summary',
            title: 'Workload Summary',
            metrics: [{ label: 'Total Items', value: 2 }],
          },
        ],
      });
      expect(widgets).toHaveLength(2);
      expect(widgets[0]).toMatchObject({
        type: 'work_item_overview',
        title: 'Project Work Items Overview',
      });
      expect(widgets[1]).toMatchObject({
        type: 'metric_summary',
        title: 'Workload Summary',
      });
    });

    it('maps experiment artifact provenance onto editor_patches widget cleanly', () => {
      const widgets = mapArtifactsToWidgets({
        editor_patches: [
          {
            id: 'patch-exp-1',
            file_path: 'main.tex',
            kind: 'insert_after',
            title: 'Insert benchmark table',
            search_text: '\\section{Experiments}',
            replace_text: '\\begin{table}...\\end{table}',
          },
        ],
        provenance: [
          {
            repo: 'flux-lab/vision-exp',
            path: 'eval/metrics.csv',
            commit_sha: 'a8f2c3e4b5d6e7f8a8f2c3e4b5d6e7f8a8f2c3e4',
            url: 'https://github.com/flux-lab/vision-exp/blob/a8f2c3e/eval/metrics.csv',
          },
          {
            repo: '',
            path: 'invalid.csv',
          },
        ],
      });

      expect(widgets).toHaveLength(1);
      expect(widgets[0]).toMatchObject({
        type: 'editor_patches',
        title: 'Proposed LaTeX Edit',
        provenance: [
          {
            repo: 'flux-lab/vision-exp',
            path: 'eval/metrics.csv',
            commitSha: 'a8f2c3e4b5d6e7f8a8f2c3e4b5d6e7f8a8f2c3e4',
            url: 'https://github.com/flux-lab/vision-exp/blob/a8f2c3e/eval/metrics.csv',
          },
        ],
      });
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
        stored as never,
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
  });
});
