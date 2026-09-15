import { AiService } from '@/modules/ai/ai.service';
import { EngineService } from '@/modules/ai/engine/engine.service';
import { ThreadService } from '@/modules/ai/thread/thread.service';
import { PrismaService } from '@/core/database/prisma.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FastifyReply } from 'fastify';

describe('Storage AI RAG Q&A & Polymorphic Paper Resolver Suite', () => {
  let aiService: AiService;
  let mockEngineService: jest.Mocked<EngineService>;
  let mockThreadService: jest.Mocked<ThreadService>;
  let mockPrisma: any;
  let mockReply: Partial<FastifyReply>;

  beforeEach(() => {
    mockEngineService = {
      health: jest.fn(),
      streamChat: jest.fn().mockResolvedValue(undefined),
      syncChat: jest.fn().mockResolvedValue({
        role: 'assistant',
        content: 'Grounding answer based on the uploaded paper.',
        sources: [{ title: 'Quantum ML', page: 1 }],
        widgets: [],
      }),
      uploadDocument: jest.fn(),
      getDocumentsBulk: jest.fn(),
      getDocument: jest.fn(),
    } as any;

    mockThreadService = {
      createChat: jest.fn(),
      getOrCreatePageChat: jest.fn(),
      appendMessages: jest.fn(),
      getChatMessages: jest.fn(),
      getChatDetail: jest.fn(),
      listUserChats: jest.fn(),
      deleteChat: jest.fn(),
      updateChatTitle: jest.fn(),
      cleanupExpiredMemory: jest.fn(),
    } as any;

    mockPrisma = {
      item: {
        findFirst: jest.fn(),
      },
      file: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      projectMember: {
        findFirst: jest.fn(),
      },
      aiChat: {
        findFirst: jest.fn(),
      },
    };

    mockReply = {
      raw: {} as any,
      hijack: jest.fn(),
    };

    aiService = new AiService(
      mockEngineService,
      mockThreadService,
      mockPrisma as PrismaService,
    );
  });

  it('should stream Q&A for an uploaded Storage File using its extracted metadata and ragDocId', async () => {
    // 1. Library item returns null
    mockPrisma.item.findFirst.mockResolvedValue(null);

    // 2. Storage file found
    const fileId = 'file-storage-pdf-001';
    const userId = 'user-researcher-1';
    mockPrisma.file.findFirst.mockResolvedValue({
      id: fileId,
      filename: 'quantum_computing.pdf',
      authorId: userId,
      linkedToType: 'project',
      linkedToId: 'project-qml',
      sharedWith: [],
      metaData: {
        title: 'Quantum Computing and Machine Learning Synergy',
        authors: ['Dr. Alice Walker', 'Prof. Bob Smith'],
        year: 2026,
        doi: '10.1016/j.qcml.2026.001',
        abstract:
          'This paper introduces hybrid quantum-classical algorithms for deep neural networks.',
        ragDocId: 'vec-doc-quantum-456',
        ragStatus: 'indexed',
        chunkCount: 16,
      },
    });

    await aiService.streamPaper(
      userId,
      fileId,
      {
        query: 'What is the main advantage of the proposed quantum algorithm?',
      },
      mockReply as FastifyReply,
    );

    expect(mockEngineService.streamChat).toHaveBeenCalledTimes(1);
    const [payload] = mockEngineService.streamChat.mock.calls[0];

    // Verify document scope is restricted strictly to the paper's vector document ID
    expect(payload.document_ids).toEqual(['vec-doc-quantum-456']);
    expect(payload.intent_hint).toBe('paper_rag_qa');

    // Verify paper grounding system prompt is injected
    const systemMsg = payload.messages.find((m: any) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain(
      'Quantum Computing and Machine Learning Synergy',
    );
    expect(systemMsg?.content).toContain('Dr. Alice Walker');
    expect(systemMsg?.content).toContain('hybrid quantum-classical algorithms');
  });

  it('should reject Q&A access if user has no permission on the Storage File', async () => {
    mockPrisma.item.findFirst.mockResolvedValue(null);
    mockPrisma.file.findFirst.mockResolvedValue({
      id: 'file-private-123',
      filename: 'confidential_research.pdf',
      authorId: 'other-user',
      linkedToType: 'personal',
      linkedToId: null,
      sharedWith: [],
      metaData: {},
    });

    await expect(
      aiService.streamPaper(
        'unauthorized-user',
        'file-private-123',
        { query: 'Tell me the secret' },
        mockReply as FastifyReply,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should execute synchronous Q&A for an uploaded Storage File', async () => {
    mockPrisma.item.findFirst.mockResolvedValue(null);
    mockPrisma.file.findFirst.mockResolvedValue({
      id: 'file-sync-456',
      filename: 'benchmark_results.pdf',
      authorId: 'user-researcher-1',
      linkedToType: null,
      linkedToId: null,
      sharedWith: [],
      metaData: {
        title: 'Benchmark Results on Transformer Models',
        ragDocId: 'vec-doc-sync-789',
      },
    });

    const response = await aiService.executePaper(
      'user-researcher-1',
      'file-sync-456',
      {
        query: 'Summarize the benchmark metrics',
      },
    );

    expect(response.content).toBe(
      'Grounding answer based on the uploaded paper.',
    );
    expect(mockEngineService.syncChat).toHaveBeenCalledTimes(1);
    const [payload] = mockEngineService.syncChat.mock.calls[0];
    expect(payload.document_ids).toEqual(['vec-doc-sync-789']);
  });

  it('should fall back transparently to Library Item when ID belongs to library item', async () => {
    mockPrisma.item.findFirst.mockResolvedValue({
      id: 'library-item-999',
      title: 'Attention Is All You Need',
      uploadedById: 'user-researcher-1',
      projectId: null,
      contributors: [{ fullName: 'Vaswani et al.' }],
      year: 2017,
      ragDocId: 'vec-doc-vaswani',
    });

    await aiService.streamPaper(
      'user-researcher-1',
      'library-item-999',
      { query: 'Explain multi-head attention' },
      mockReply as FastifyReply,
    );

    expect(mockEngineService.streamChat).toHaveBeenCalledTimes(1);
    const [payload] = mockEngineService.streamChat.mock.calls[0];
    expect(payload.document_ids).toEqual(['vec-doc-vaswani']);
  });

  it('should throw NotFoundException if ID matches neither Library Item nor Storage File', async () => {
    mockPrisma.item.findFirst.mockResolvedValue(null);
    mockPrisma.file.findFirst.mockResolvedValue(null);

    await expect(
      aiService.streamPaper(
        'user-1',
        'non-existent-id',
        { query: 'Hello?' },
        mockReply as FastifyReply,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
