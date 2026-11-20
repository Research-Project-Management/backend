import 'reflect-metadata';
import { ValidationPipe, ForbiddenException } from '@nestjs/common';
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

describe('Khối 2 / Tầng 5 Backend — AI Writing Assistant & Page Chat', () => {
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
});
