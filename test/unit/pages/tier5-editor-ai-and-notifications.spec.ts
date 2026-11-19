import 'reflect-metadata';
import { ValidationPipe, ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { fromPartial } from '@total-typescript/shoehorn';
import type { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import type { PrismaService, RedisCacheService } from '@/core';
import type { IAiEnginePort } from '@/modules/ai/engine/engine.port';
import { AiFacade } from '@/modules/ai/ai.facade';
import { AccessRepository } from '@/modules/ai/access/access.repository';
import { AccessService } from '@/modules/ai/access/services/access.service';
import { DocumentAccessService } from '@/modules/ai/access/services/document.service';
import { SpaceAccessService } from '@/modules/ai/access/services/space.service';
import { ChatRepository } from '@/modules/ai/chat/chat.repository';
import { buildEngineChatRequest } from '@/modules/ai/chat/domain/context.mapper';
import { QueryDto } from '@/modules/ai/chat/dto/query.dto';
import { ChatService } from '@/modules/ai/chat/services/chat.service';
import { SessionService } from '@/modules/ai/chat/services/session.service';
import { TitleService } from '@/modules/ai/chat/services/title.service';
import { ClsiService } from '@/modules/pages/clsi/services/clsi.service';
import { NotificationsController } from '@/modules/notifications/notifications.controller';
import {
  QueryNotificationsDto,
  ParseMentionsDto,
} from '@/modules/notifications/dto/notification.dto';
import { EventRealtimeNotifierAdapter } from '@/modules/notifications/core/adapters/realtime/event-realtime-notifier.adapter';
import { NotificationEntity } from '@/modules/notifications/core/domain/entities/notification.entity';
import { ReviewNotificationBundlingUseCase } from '@/modules/notifications/core/use-cases/review-notification-bundling.use-case';
import { ReviewDigest } from '@/modules/notifications/core/domain/value-objects/review-bundle';
import {
  ReviewCommentsController,
  ReviewSuggestionsController,
  ReviewCommentsService,
  ReviewSuggestionsService,
  ReviewNotificationDispatcher,
} from '@/modules/pages/track-changes';

describe('Khối 2 / Tầng 5 Backend — AI Writing Assistant, Inline Diff & Notifications', () => {
  describe('1. AiFacade.generate & ClsiService AI Writing / Error Assist', () => {
    it('AiFacade.generate delegates to stateless direct chatSync with system/user messages and extracts text', async () => {
      const mockEnginePort = fromPartial<IAiEnginePort>({
        chatSync: jest.fn().mockResolvedValue({
          content: 'Formal academic revision.',
          route: 'direct',
          status: 'completed',
          citations: [],
          sources: [],
          interrupts: [],
          usage: {},
          trace_id: 'trace-1',
        }),
      });
      const facade = new AiFacade(mockEnginePort);

      const res = await facade.generate({
        prompt: 'Make formal',
        systemInstruction: 'System prompt',
        temperature: 0.25,
        userId: 'user-1',
        spaceId: 'space-1',
      });

      expect(res).toEqual({ text: 'Formal academic revision.' });
      expect(mockEnginePort.chatSync).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: 'space-1',
          stateless: true,
          intent_hint: 'direct',
          context: { temperature: 0.25 },
          messages: [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'Make formal' },
          ],
        }),
      );
    });

    it('ClsiService.transformAcademicText forwards surrounding context, unmasks LaTeX, and preserves outer whitespace', async () => {
      const mockConfig = fromPartial<ConfigService>({ get: jest.fn() });
      const mockAiEngine = {
        generate: jest.fn(async ({ prompt }: { prompt: string }) => {
          expect(prompt).toContain('Document Title: Quantum Survey');
          expect(prompt).toContain('Intro context');
          expect(prompt).toContain('Outro context');
          const match = prompt.match(/__LATEX_INLINE_MATH_\d+__/);
          const citeMatch = prompt.match(/__LATEX_CITE_\d+__/);
          return {
            text: `Empirical findings establish ${match?.[0] ?? ''} per ${citeMatch?.[0] ?? ''}.`,
          };
        }),
      };

      const clsi = new ClsiService(
        mockConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockAiEngine,
      );

      const res = await clsi.transformAcademicText(
        {
          action: 'academic-tone',
          selectedText: '  Results show $E=mc^2$ per \\cite{einstein1905}. \n',
          contextBefore: 'Intro context',
          contextAfter: 'Outro context',
          documentTitle: 'Quantum Survey',
        },
        'user-1',
      );

      expect(res.success).toBe(true);
      expect(res.suggestedText).toBe(
        '  Empirical findings establish $E=mc^2$ per \\cite{einstein1905}. \n',
      );
    });

    it('ClsiService.transformAcademicText enforces workspace access via AiFacade.authorizeScope when spaceId is provided', async () => {
      const mockConfig = fromPartial<ConfigService>({ get: jest.fn() });
      const mockPrisma = fromPartial<PrismaService>({
        space: {
          findFirst: jest.fn().mockResolvedValue({
            id: '11111111-1111-1111-1111-111111111111',
            type: 'personal',
            ownerUserId: 'other-user',
            projectId: null,
          }),
        },
      });
      const mockEnginePort = fromPartial<IAiEnginePort>({
        chatSync: jest.fn(),
      });
      const accessRepo = new AccessRepository(mockPrisma);
      const spaceAccess = new SpaceAccessService(accessRepo);
      const docAccess = new DocumentAccessService(accessRepo, spaceAccess);
      const accessService = new AccessService(spaceAccess, docAccess);
      const aiFacade = new AiFacade(mockEnginePort, accessService);

      const clsi = new ClsiService(
        mockConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        aiFacade,
      );

      await expect(
        clsi.transformAcademicText(
          {
            action: 'academic-tone',
            selectedText: 'Draft text',
            spaceId: '11111111-1111-1111-1111-111111111111',
          },
          'intruder-user',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('ClsiService.fixLatexError returns clean \\usepackage{booktabs} snippet without comment noise', async () => {
      const mockConfig = fromPartial<ConfigService>({ get: jest.fn() });
      const clsi = new ClsiService(mockConfig);
      const fix = await clsi.fixLatexError({
        errorMessage: 'Undefined control sequence. \\toprule',
        errorLine: 8,
        detail: '\\toprule',
        surroundingCode:
          '\\begin{tabular}{cc}\n\\toprule\nA & B\\\\\n\\end{tabular}',
      });

      expect(fix.confidence).toBe('high');
      expect(fix.fixedSnippet).toBe('\\usepackage{booktabs}');
      expect(fix.explanation).toContain('booktabs');
    });
  });

  describe('2. Editor DTO Normalization, Payload Context & Page Chat Personal Space', () => {
    it('ValidationPipe({ whitelist: true, transform: true }) normalizes snake_case + null into canonical camelCase QueryDto and strips unknown fields', async () => {
      const pipe = new ValidationPipe({ whitelist: true, transform: true });
      const rawBody = {
        query: 'Refine this proof',
        space_id: 'sp-1',
        page_id: 'page-1',
        web_search_sites: null,
        projectId: 'legacy-proj-alias',
        context_before: '\\section{Intro}',
        context_after: '\\section{Conclusion}',
        current_section: 'Preliminaries',
        current_environment: 'theorem',
        document_structure_summary: '1. Intro\n2. Preliminaries',
        user_selection: 'Let x > 0',
        compile_errors: ['Undefined control sequence'],
        document_structure: [{ title: 'Intro', line: 1 }],
      };

      const transformed = (await pipe.transform(rawBody, {
        type: 'body',
        metatype: QueryDto,
      })) as QueryDto;

      expect(transformed.spaceId).toBe('sp-1');
      expect(transformed.pageId).toBe('page-1');
      expect(transformed.webSearchSites).toBeUndefined();
      expect(transformed.contextBefore).toBe('\\section{Intro}');
      expect(transformed.contextAfter).toBe('\\section{Conclusion}');
      expect(transformed.currentSection).toBe('Preliminaries');
      expect(transformed.currentEnvironment).toBe('theorem');
      expect(transformed.documentStructureSummary).toBe(
        '1. Intro\n2. Preliminaries',
      );
      expect(transformed.userSelection).toBe('Let x > 0');
      expect(transformed.compileErrors).toEqual(['Undefined control sequence']);
      expect(transformed.documentStructure).toEqual([
        { title: 'Intro', line: 1 },
      ]);
      const rawRecord = transformed as unknown as Record<string, unknown>;
      expect(rawRecord.projectId).toBeUndefined();
      expect(rawRecord.space_id).toBeUndefined();

      const dtoInstance = plainToInstance(QueryDto, rawBody);
      const errors = await validate(dtoInstance);
      expect(errors).toHaveLength(0);
    });

    it('buildEngineChatRequest populates nested editor context cleanly and maps allowed_domains', () => {
      const dto: QueryDto = {
        messages: [
          {
            role: 'user',
            content: 'Explain lemma',
            attachments: [{ id: 'doc-1', name: 'paper.pdf' }],
          },
        ],
        spaceId: 'personal',
        pageId: 'page-123',
        contextBefore: 'Before text',
        contextAfter: 'After text',
        currentSection: 'Method',
        currentEnvironment: 'proof',
        documentStructureSummary: 'Outline summary',
        compileErrors: ['Missing $'],
        userSelection: 'x_i',
        useRag: true,
        webSearchSites: ['arxiv.org'],
      };

      const payload = buildEngineChatRequest({
        userId: 'user-uuid-1',
        spaceId: 'user-uuid-1',
        chatId: null,
        dto,
      });
      expect(payload.space_id).toBe('user-uuid-1');
      expect(payload.page_id).toBe('page-123');
      expect(payload.stateless).toBe(true);
      expect(payload.context).toEqual(
        expect.objectContaining({
          page_id: 'page-123',
          context_before: 'Before text',
          context_after: 'After text',
          current_section: 'Method',
          current_environment: 'proof',
          document_structure_summary: 'Outline summary',
          compile_errors: ['Missing $'],
          user_selection: 'x_i',
          use_rag: true,
          allowed_domains: ['arxiv.org'],
        }),
      );
    });

    it('ChatService.stream authorizes Personal Space pages via prisma.space and canonicalizes PageDoc -> Page.id', async () => {
      const userId = '11111111-1111-1111-1111-111111111111';
      const personalSpaceId = '22222222-2222-2222-2222-222222222222';
      const canonicalPageId = '33333333-3333-3333-3333-333333333333';
      const childDocId = '44444444-4444-4444-4444-444444444444';

      const mockEngine = fromPartial<IAiEnginePort>({
        chatStream: jest.fn().mockResolvedValue(undefined),
        deleteThread: jest
          .fn()
          .mockResolvedValue({ space_id: personalSpaceId, deleted: true }),
      });
      const mockPrisma = fromPartial<PrismaService>({
        space: {
          findFirst: jest.fn().mockResolvedValue({
            id: personalSpaceId,
            type: 'personal',
            ownerUserId: userId,
            projectId: null,
          }),
        },
        project: { findFirst: jest.fn().mockResolvedValue(null) },
        page: { findFirst: jest.fn().mockResolvedValue(null) },
        pageDoc: {
          findFirst: jest.fn().mockResolvedValue({
            id: childDocId,
            pageId: canonicalPageId,
            spaceId: personalSpaceId,
          }),
        },
        aiChat: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'chat-1',
            createdById: userId,
            spaceId: personalSpaceId,
            pageId: canonicalPageId,
            title: 'Doc Chat',
            documentIds: [],
            messages: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({
            id: 'chat-1',
            createdById: userId,
            spaceId: personalSpaceId,
            pageId: canonicalPageId,
            title: 'Doc Chat',
            documentIds: [],
            messages: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        aiMessage: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const accessRepo = new AccessRepository(mockPrisma);
      const spaceAccess = new SpaceAccessService(accessRepo);
      const docAccess = new DocumentAccessService(accessRepo, spaceAccess);
      const accessService = new AccessService(spaceAccess, docAccess);
      const chatRepo = new ChatRepository(mockPrisma);
      const sessionService = new SessionService(
        chatRepo,
        spaceAccess,
        undefined,
        mockEngine,
      );
      const titleService = new TitleService(chatRepo, sessionService);
      const chatService = new ChatService(
        mockEngine,
        accessService,
        sessionService,
        titleService,
      );

      const mockReply = fromPartial<FastifyReply>({
        raw: { writeHead: jest.fn(), write: jest.fn(), end: jest.fn() },
        hijack: jest.fn(),
      });

      await chatService.stream(
        userId,
        {
          spaceId: personalSpaceId,
          pageId: childDocId,
          query: 'Help with theorem',
        },
        mockReply,
      );

      expect(mockEngine.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: personalSpaceId,
          page_id: canonicalPageId,
          chat_id: 'chat-1',
        }),
        mockReply,
        expect.any(Object),
      );
    });

    it('SessionService resolves "personal" alias to valid Space UUID FK and clearPageChat deletes all matching chats + Python threads', async () => {
      const userId = '11111111-1111-1111-1111-111111111111';
      const personalSpaceUuid = '22222222-2222-2222-2222-222222222222';
      const canonicalPageId = '33333333-3333-3333-3333-333333333333';

      const deleteManyFn = jest.fn().mockResolvedValue({ count: 2 });
      const createFn = jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => ({
            ...data,
            id: 'chat-created',
            messages: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );

      const mockPrisma = fromPartial<PrismaService>({
        space: {
          findFirst: jest.fn().mockResolvedValue({
            id: personalSpaceUuid,
            type: 'personal',
            ownerUserId: userId,
            projectId: null,
          }),
        },
        project: { findFirst: jest.fn() },
        page: {
          findFirst: jest.fn().mockResolvedValue({
            id: canonicalPageId,
            title: 'My Manuscript',
            spaceId: personalSpaceUuid,
          }),
        },
        pageDoc: { findFirst: jest.fn() },
        aiChat: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            { id: 'chat-a', spaceId: personalSpaceUuid },
            { id: 'chat-b', spaceId: personalSpaceUuid },
          ]),
          create: createFn,
          deleteMany: deleteManyFn,
        },
      });

      const cacheDel = jest.fn().mockResolvedValue(undefined);
      const cacheMock = fromPartial<RedisCacheService>({
        get: jest.fn(),
        set: jest.fn(),
        del: cacheDel,
      });
      const deleteThreadFn = jest
        .fn()
        .mockResolvedValue({ space_id: personalSpaceUuid, deleted: true });
      const engineMock = fromPartial<IAiEnginePort>({
        deleteThread: deleteThreadFn,
      });

      const accessRepo = new AccessRepository(mockPrisma);
      const spaceAccess = new SpaceAccessService(accessRepo);
      const repo = new ChatRepository(mockPrisma);
      const sessionService = new SessionService(
        repo,
        spaceAccess,
        cacheMock,
        engineMock,
      );

      const session = await sessionService.getOrCreatePageChat(
        canonicalPageId,
        userId,
        'personal',
      );
      expect(session.id).toBe('chat-created');
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            spaceId: personalSpaceUuid,
            pageId: canonicalPageId,
          }),
        }),
      );

      await sessionService.clearPageChat(canonicalPageId, userId);
      expect(deleteManyFn).toHaveBeenCalledWith({
        where: { id: { in: ['chat-a', 'chat-b'] } },
      });
      expect(deleteThreadFn).toHaveBeenCalledWith(personalSpaceUuid, 'chat-a');
      expect(deleteThreadFn).toHaveBeenCalledWith(personalSpaceUuid, 'chat-b');
      expect(cacheDel).toHaveBeenCalled();
    });
  });

  describe('3. Notifications Routes, Query Transform, Realtime Payload, Multi-Page Bundling & Review Controllers Dispatch', () => {
    it('NotificationsController exposes api/v1/pages/notifications, enforces currentUserId on parseMentions, and QueryNotificationsDto parses isRead="false"', async () => {
      const controllerPaths = Reflect.getMetadata(
        PATH_METADATA,
        NotificationsController,
      );
      expect(controllerPaths).toEqual(
        expect.arrayContaining([
          'api/v1/notifications',
          'api/v1/pages/notifications',
        ]),
      );
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          NotificationsController.prototype.patchMarkAllAsRead,
        ),
      ).toBe('read-all');

      const qDto = plainToInstance(QueryNotificationsDto, {
        isRead: 'false',
        limit: '20',
      });
      expect(qDto.isRead).toBe(false);
      expect(qDto.limit).toBe(20);

      const qDtoTrue = plainToInstance(QueryNotificationsDto, {
        isRead: 'true',
      });
      expect(qDtoTrue.isRead).toBe(true);

      const mentionDto = plainToInstance(ParseMentionsDto, {
        text: 'Check @alice',
        spaceId: 'sp-personal-1',
      });
      const errs = await validate(mentionDto);
      expect(errs).toHaveLength(0);

      const notifSvcMock = {
        parseAndNotifyMentions: jest.fn().mockResolvedValue({
          tokens: [],
          dispatchedNotifications: [],
        }),
      };
      const controller = new NotificationsController(
        notifSvcMock as any,
        {} as any,
      );
      await controller.parseMentions(
        { text: 'Hi @alice', actorId: 'spoofed-user', spaceId: 'sp-1' },
        'authenticated-user',
      );
      expect(notifSvcMock.parseAndNotifyMentions).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'authenticated-user',
          spaceId: 'sp-1',
        }),
      );
    });

    it('EventRealtimeNotifierAdapter emits flat + nested notification:new payload', async () => {
      const realtimeMock = { notifyUser: jest.fn() };
      const adapter = new EventRealtimeNotifierAdapter(realtimeMock as any);
      const entity = new NotificationEntity({
        id: 'n-1',
        userId: 'u-1',
        templateKey: 'comment_reply',
        type: 'comment_reply',
        spaceId: 'sp-1',
        projectId: null,
        docId: 'doc-1',
        messageOpts: { pageId: 'page-1', isPersonalSpace: true },
      });

      await adapter.notifyUser('u-1', entity, 3);
      expect(realtimeMock.notifyUser).toHaveBeenCalledWith(
        'u-1',
        'notification:new',
        expect.objectContaining({
          id: 'n-1',
          templateKey: 'comment_reply',
          spaceId: 'sp-1',
          projectId: null,
          unreadCount: 3,
          notification: expect.objectContaining({
            id: 'n-1',
            templateKey: 'comment_reply',
          }),
        }),
      );
    });

    it('ReviewNotificationBundlingUseCase isolates bundles by (spaceId, pageId) including Personal Space and flushes per page', async () => {
      const notifications = [
        new NotificationEntity({
          id: 'n-p1',
          userId: 'u1',
          templateKey: 'comment_reply',
          type: 'comment_reply',
          spaceId: 'sp-personal',
          projectId: null,
          docId: 'doc-1',
          actorId: 'a1',
          messageOpts: {
            actorName: 'Alice',
            pageId: 'page-1',
            isPersonalSpace: true,
            snippet: 'Page 1 note',
          },
          isRead: false,
        }),
        new NotificationEntity({
          id: 'n-p2',
          userId: 'u1',
          templateKey: 'mention',
          type: 'mention',
          spaceId: 'sp-personal',
          projectId: null,
          docId: 'doc-2',
          actorId: 'a2',
          messageOpts: {
            actorName: 'Bob',
            pageId: 'page-2',
            isPersonalSpace: true,
            snippet: 'Page 2 note',
          },
          isRead: false,
        }),
      ];

      const repo: any = {
        findByUser: jest.fn(async () => notifications),
        markManyAsRead: jest.fn(async () => 1),
        markAsRead: jest.fn(async () => true),
      };
      const digests: ReviewDigest[] = [];
      const store: any = {
        getSettings: async () => ({ enabled: true, windowMinutes: 10 }),
        saveSettings: async (_u: string, s: any) => s,
        appendDigest: async (_u: string, d: ReviewDigest) =>
          void digests.push(d),
        listDigests: async () => digests,
      };

      const uc = new ReviewNotificationBundlingUseCase(repo, store);
      const pending = await uc.getPendingBundles('u1');
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.bundle.bundleKey).sort()).toEqual([
        'sp-personal:page-1',
        'sp-personal:page-2',
      ]);

      const flushed = await uc.flush('u1', {
        bundleKey: 'sp-personal:page-1',
        spaceId: 'sp-personal',
        pageId: 'page-1',
      });
      expect(flushed?.itemCount).toBe(1);
      expect(flushed?.pageId).toBe('page-1');
      expect(flushed?.spaceId).toBe('sp-personal');
      expect(repo.markManyAsRead).toHaveBeenCalledWith(['n-p1'], 'u1');
    });

    it('ReviewCommentsController & ReviewSuggestionsController dispatch mention, reply, resolve, and suggestion notifications via PagesNotificationsService', async () => {
      const spaceId = '11111111-1111-1111-1111-111111111111';
      const pageId = '22222222-2222-2222-2222-222222222222';
      const docId = '33333333-3333-3333-3333-333333333333';
      const actorId = '44444444-4444-4444-4444-444444444444';
      const ownerId = '55555555-5555-5555-5555-555555555555';
      const threadId = '66666666-6666-6666-6666-666666666666';

      const pagesNotifMock = {
        parseAndNotifyMentions: jest
          .fn()
          .mockResolvedValue({ tokens: [], dispatchedNotifications: [] }),
        notifyCommentReply: jest.fn().mockResolvedValue({}),
        notifyThreadResolved: jest.fn().mockResolvedValue({}),
        dismissThreadResolved: jest.fn().mockResolvedValue(1),
        notifyReviewSuggestion: jest.fn().mockResolvedValue({}),
      };

      const prismaMock = {
        space: {
          findFirst: jest.fn().mockResolvedValue({
            id: spaceId,
            type: 'personal',
            ownerUserId: ownerId,
            projectId: null,
          }),
        },
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: ownerId, email: 'owner@example.com' }),
        },
        pageDoc: { findFirst: jest.fn().mockResolvedValue({ pageId }) },
      };

      const docMock = { id: docId, pageId, spaceId };
      const threadRecord = {
        id: threadId,
        spaceId,
        pageId,
        docId,
        quote: 'Check section',
        range: { startLine: 1, endLine: 1, startCol: 0, endCol: 0 },
        startLine: 1,
        endLine: 1,
        isResolved: false,
        createdById: ownerId,
        createdAt: new Date(),
        updatedAt: new Date(),
        replies: [
          {
            id: '77777777-7777-7777-7777-777777777777',
            content: 'Reply to @owner',
            createdById: actorId,
            createdAt: new Date(),
          },
        ],
      };

      const scopeRepoMock = {
        getPrisma: () => prismaMock,
        findDocInProject: jest.fn().mockResolvedValue(docMock),
        findThreadInProject: jest.fn().mockResolvedValue(threadRecord),
        updateThreadInProject: jest.fn().mockResolvedValue(undefined),
      };
      const trackRepoMock = {
        saveCommentThread: jest.fn().mockImplementation(async (e) => e),
        addCommentReply: jest.fn().mockResolvedValue(undefined),
        saveChange: jest.fn().mockImplementation(async (e) => e),
      };
      const userResolverMock = {
        resolveUserNames: jest.fn().mockResolvedValue(
          new Map([
            [actorId, { id: actorId, name: 'Reviewer Actor' }],
            [ownerId, { id: ownerId, name: 'Paper Owner' }],
          ]),
        ),
      };
      const pageServiceMock = {
        resolveActiveProjectId: jest.fn((v) =>
          typeof v === 'string' ? v : v?.id,
        ),
        resolveProjectId: jest.fn().mockResolvedValue(spaceId),
      };

      const dispatcher = new ReviewNotificationDispatcher(
        userResolverMock,
        scopeRepoMock as any,
        scopeRepoMock as any,
        pagesNotifMock as any,
      );
      const commentsController = new ReviewCommentsController(
        new ReviewCommentsService(
          scopeRepoMock as any,
          scopeRepoMock as any,
          userResolverMock,
          pageServiceMock as any,
          dispatcher,
          trackRepoMock as any,
        ),
      );
      const suggestionsController = new ReviewSuggestionsController(
        new ReviewSuggestionsService(
          {} as any,
          scopeRepoMock as any,
          scopeRepoMock as any,
          userResolverMock,
          pageServiceMock as any,
          dispatcher,
          undefined,
          trackRepoMock as any,
        ),
      );

      const req = {
        user: { id: actorId, email: 'reviewer@example.com' },
      } as any;

      await commentsController.createComment(
        docId,
        { content: 'Please check @owner', line: 1, spaceId },
        req,
        spaceId,
        spaceId,
      );
      expect(pagesNotifMock.parseAndNotifyMentions).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId,
          pageId,
          docId,
          isPersonalSpace: true,
        }),
      );

      await commentsController.addCommentReply(
        docId,
        threadId,
        { content: 'Reply to @owner' },
        req,
        spaceId,
        spaceId,
      );
      expect(pagesNotifMock.notifyCommentReply).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientUserId: ownerId,
          actorId,
          spaceId,
          pageId,
        }),
      );

      await commentsController.resolveComment(
        docId,
        threadId,
        { resolved: true },
        spaceId,
        spaceId,
        actorId,
      );
      expect(pagesNotifMock.notifyThreadResolved).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientUserId: ownerId,
          actorId,
          spaceId,
          pageId,
        }),
      );

      await suggestionsController.createSuggestion(
        docId,
        {
          type: 'insert',
          suggestedText: 'Better phrasing @owner',
          fromLine: 1,
          toLine: 1,
          spaceId,
        },
        req,
        spaceId,
        spaceId,
      );
      expect(pagesNotifMock.notifyReviewSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientUserId: ownerId,
          actorId,
          spaceId,
          pageId,
        }),
      );
    });
  });
});
