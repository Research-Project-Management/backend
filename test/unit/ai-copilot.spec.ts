import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from '@/modules/ai/ai.service';
import { EngineService } from '@/modules/ai/engine/engine.service';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { PrismaService } from '@/core/database/prisma.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

describe('AiService (Unified Copilot & Intelligence Engine)', () => {
  let service: AiService;
  let engineService: any;
  let threadService: any;
  let prisma: any;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockOtherUserId = '22222222-2222-2222-2222-222222222222';
  const mockProjectId = '33333333-3333-3333-3333-333333333333';
  const mockChatId = '55555555-5555-5555-5555-555555555555';
  const mockPaperId = '66666666-6666-6666-6666-666666666666';

  beforeEach(async () => {
    engineService = {
      health: jest.fn().mockResolvedValue({ status: 'ok' }),
      streamChat: jest.fn().mockResolvedValue(undefined),
      syncChat: jest.fn().mockResolvedValue({
        role: 'assistant',
        content: 'AI Response',
        sources: [],
      }),
      uploadDocument: jest.fn().mockResolvedValue({ doc_id: 'doc-123' }),
      getDocumentsBulk: jest.fn().mockResolvedValue([{ id: 'doc-123' }]),
      getDocument: jest.fn().mockResolvedValue({ id: 'doc-123' }),
      getDocuments: jest.fn().mockResolvedValue([{ id: 'doc-123' }]),
    };

    threadService = {
      appendMessages: jest.fn().mockResolvedValue({}),
    };

    prisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue({ id: mockProjectId }),
      },
      projectMember: {
        findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }),
      },
      aiChat: {
        findFirst: jest.fn().mockResolvedValue({ id: mockChatId, userId: mockUserId }),
      },
      item: {
        findFirst: jest.fn().mockResolvedValue({
          id: mockPaperId,
          title: 'Quantum Entanglement in Machine Learning',
          uploadedById: mockUserId,
          projectId: mockProjectId,
          year: 2026,
          doi: '10.1000/182',
          abstract: 'We explore quantum algorithms in deep learning.',
          contributors: [{ fullName: 'Dr. Alice' }, { fullName: 'Dr. Bob' }],
          ragDocId: 'rag-paper-123',
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: EngineService, useValue: engineService },
        { provide: ThreadService, useValue: threadService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  describe('Health & Service Status', () => {
    it('should return engine health status', async () => {
      const status = await service.health();
      expect(status).toEqual({ status: 'ok' });
      expect(engineService.health).toHaveBeenCalled();
    });
  });

  describe('Access Control & Validation', () => {
    it('should throw ForbiddenException if user has no access to project', async () => {
      prisma.project.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.execute(mockUserId, {
          projectId: mockProjectId,
          query: 'Summarize project tasks',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException if user has no access to chat session', async () => {
      prisma.aiChat.findFirst.mockResolvedValueOnce({
        id: mockChatId,
        userId: mockOtherUserId,
      });
      await expect(
        service.execute(mockUserId, {
          chatId: mockChatId,
          query: 'Continue discussion',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Synchronous AI Copilot Query', () => {
    it('should execute synchronous AI chat query and return assistant reply', async () => {
      const response = await service.execute(mockUserId, {
        query: 'What is the methodology of this study?',
      });
      expect(response).toEqual({
        role: 'assistant',
        content: 'AI Response',
        sources: [],
      });
      expect(engineService.syncChat).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
          messages: [{ role: 'user', content: 'What is the methodology of this study?' }],
        }),
      );
    });
  });

  describe('Streaming AI Copilot Query', () => {
    it('should stream AI chat query and persist user message if chatId provided', async () => {
      const mockReply = {} as any;
      await service.stream(
        mockUserId,
        {
          chatId: mockChatId,
          messages: [{ role: 'user', content: 'Stream this response' }],
        },
        mockReply,
      );

      expect(threadService.appendMessages).toHaveBeenCalledWith(
        mockChatId,
        mockUserId,
        {
          messages: [{ role: 'user', content: 'Stream this response' }],
        },
      );
      expect(engineService.streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: mockChatId,
          user_id: mockUserId,
        }),
        mockReply,
      );
    });
  });

  describe('Paper-Scoped Grounding & RAG', () => {
    it('should stream paper-scoped RAG response with paper metadata grounding', async () => {
      const mockReply = {} as any;
      await service.streamPaper(
        mockUserId,
        mockPaperId,
        { query: 'Explain the main formula in this paper' },
        mockReply,
      );

      expect(engineService.streamChat).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
          document_ids: ['rag-paper-123'],
          intent_hint: 'paper_rag_qa',
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'system',
              content: expect.stringContaining('Quantum Entanglement in Machine Learning'),
            }),
          ]),
        }),
        mockReply,
      );
    });

    it('should execute paper-scoped sync RAG query', async () => {
      const result = await service.executePaper(mockUserId, mockPaperId, {
        query: 'What dataset was used in this paper?',
      });

      expect(result).toBeDefined();
      expect(engineService.syncChat).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
          document_ids: ['rag-paper-123'],
        }),
      );
    });

    it('should throw NotFoundException if paper does not exist', async () => {
      prisma.item.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.executePaper(mockUserId, 'non-existent-paper', {
          query: 'Test',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if user has no access to paper', async () => {
      prisma.item.findFirst.mockResolvedValueOnce({
        id: mockPaperId,
        uploadedById: mockOtherUserId,
        projectId: mockProjectId,
        contributors: [],
      });
      prisma.projectMember.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.executePaper(mockUserId, mockPaperId, {
          query: 'Test',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Document & Vector Store Management', () => {
    it('should upload document with scope isolation', async () => {
      const buffer = Buffer.from('test document');
      const result = await service.uploadDocument(
        mockUserId,
        buffer,
        'application/pdf',
        'paper.pdf',
        { projectId: mockProjectId },
      );

      expect(result).toEqual({ doc_id: 'doc-123' });
      expect(engineService.uploadDocument).toHaveBeenCalledWith(
        buffer,
        'application/pdf',
        'paper.pdf',
        expect.objectContaining({
          userId: mockUserId,
          scopeId: mockProjectId,
          projectId: mockProjectId,
        }),
      );
    });

    it('should bulk retrieve documents with access check', async () => {
      const docs = await service.getDocumentsBulk(mockUserId, ['doc-123'], mockProjectId);
      expect(docs).toHaveLength(1);
      expect(engineService.getDocumentsBulk).toHaveBeenCalledWith(
        ['doc-123'],
        expect.objectContaining({
          userId: mockUserId,
          scopeId: mockProjectId,
        }),
      );
    });

    it('should retrieve single document from vector store', async () => {
      const doc = await service.getDocument(mockUserId, 'doc-123', mockProjectId);
      expect(doc).toEqual({ id: 'doc-123' });
      expect(engineService.getDocument).toHaveBeenCalledWith(
        'doc-123',
        expect.objectContaining({
          userId: mockUserId,
          scopeId: mockProjectId,
        }),
      );
    });

    it('should list all documents in vector store for user/project scope', async () => {
      const docs = await service.getDocuments(mockUserId, mockProjectId);
      expect(docs).toHaveLength(1);
      expect(engineService.getDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          scopeId: mockProjectId,
        }),
      );
    });
  });
});
