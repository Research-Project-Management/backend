import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import type { FastifyReply } from 'fastify';
import type { PrismaService } from '@/core';
import { AccessRepository } from '@/modules/ai/access/access.repository';
import { AccessService } from '@/modules/ai/access/services/access.service';
import { DocumentAccessService } from '@/modules/ai/access/services/document.service';
import { SpaceAccessService } from '@/modules/ai/access/services/space.service';
import { PaperChatService } from '@/modules/ai/chat/services/paper.service';
import type { IAiEnginePort } from '@/modules/ai/engine/engine.port';

describe('PaperChatService & AccessService RAG Q&A Suite', () => {
  let paperService: PaperChatService;
  let mockEngine: jest.Mocked<IAiEnginePort>;
  let mockPrisma: {
    space: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    project: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    projectMember: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    aiChat: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    libraryItem: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    fileNode: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    attachment: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
  };
  let mockReply: FastifyReply;

  beforeEach(() => {
    mockEngine = {
      health: jest.fn(),
      listAgents: jest.fn(),
      listModels: jest.fn(),
      chatSync: jest.fn().mockResolvedValue({
        content: 'Grounding answer based on the uploaded paper.',
        route: 'rag_agent',
        status: 'completed',
        citations: [
          { source_id: 'vec-doc-sync-789', title: 'Quantum ML', page: 1 },
        ],
        sources: [
          { source: 'vec-doc-sync-789 (p.1)', title: 'Quantum ML', page: 1 },
        ],
        interrupts: [],
        usage: {},
        trace_id: 'trace-paper',
      }),
      chatStream: jest.fn().mockResolvedValue(undefined),
      resumeSync: jest.fn(),
      resumeStream: jest.fn(),
      cancelThread: jest.fn(),
      deleteThread: jest.fn(),
      deleteSpaceThreads: jest.fn(),
      ingestDocument: jest.fn(),
      enqueueKnowledgeIngest: jest.fn(),
      getKnowledgeJob: jest.fn(),
      searchKnowledge: jest.fn(),
      deleteKnowledgeSource: jest.fn(),
    };

    mockPrisma = {
      space: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      project: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      projectMember: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      aiChat: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      libraryItem: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      fileNode: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      attachment: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
    };

    const prismaService = fromPartial<PrismaService>(mockPrisma);
    const accessRepo = new AccessRepository(prismaService);
    const spaceAccess = new SpaceAccessService(accessRepo);
    const docAccess = new DocumentAccessService(accessRepo, spaceAccess);
    const accessService = new AccessService(spaceAccess, docAccess);

    paperService = new PaperChatService(mockEngine, accessService);

    mockReply = fromPartial<FastifyReply>({
      raw: {},
      hijack: jest.fn(),
    });
  });

  it('streams Q&A for an uploaded StorageFile with rag_agent intent and paper context', async () => {
    const fileId = 'file-storage-pdf-001';
    const userId = 'user-researcher-1';
    mockPrisma.fileNode.findFirst.mockResolvedValue({
      id: fileId,
      filename: 'quantum_computing.pdf',
      createdById: userId,
      spaceId: 'space-qml',
      linkedToType: 'project',
      linkedToId: 'project-qml',
      sharedWith: [],
      metadata: {
        title: 'Quantum Computing and Machine Learning Synergy',
        authors: ['Dr. Alice Walker', 'Prof. Bob Smith'],
        year: 2026,
        doi: '10.1016/j.qcml.2026.001',
        abstract:
          'This paper introduces hybrid quantum-classical algorithms for deep neural networks.',
        ragDocId: 'vec-doc-quantum-456',
      },
    });

    await paperService.stream(
      userId,
      fileId,
      {
        query: 'What is the main advantage of the proposed quantum algorithm?',
      },
      mockReply,
    );

    expect(mockEngine.chatStream).toHaveBeenCalledTimes(1);
    const [request] = mockEngine.chatStream.mock.calls[0];

    expect(request.space_id).toBe('space-qml');
    expect(request.document_ids).toEqual(['vec-doc-quantum-456']);
    expect(request.intent_hint).toBe('rag_agent');

    const systemMsg = request.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain(
      'Quantum Computing and Machine Learning Synergy',
    );
    expect(systemMsg?.content).toContain('Dr. Alice Walker');
    expect(systemMsg?.content).toContain('hybrid quantum-classical algorithms');
  });

  it('rejects Q&A access when user has no permission on StorageFile', async () => {
    mockPrisma.fileNode.findFirst.mockResolvedValue({
      id: 'file-private-123',
      filename: 'confidential_research.pdf',
      createdById: 'other-user',
      spaceId: 'other-space',
      linkedToType: null,
      linkedToId: null,
      sharedWith: [],
      metadata: {},
    });

    await expect(
      paperService.stream(
        'unauthorized-user',
        'file-private-123',
        { query: 'Tell me the secret' },
        mockReply,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('executes synchronous Q&A for an uploaded StorageFile', async () => {
    mockPrisma.fileNode.findFirst.mockResolvedValue({
      id: 'file-sync-456',
      filename: 'benchmark_results.pdf',
      createdById: 'user-researcher-1',
      spaceId: 'user-researcher-1',
      linkedToType: null,
      linkedToId: null,
      sharedWith: [],
      metadata: {
        title: 'Benchmark Results on Transformer Models',
        ragDocId: 'vec-doc-sync-789',
      },
    });

    const response = await paperService.execute(
      'user-researcher-1',
      'file-sync-456',
      { query: 'Summarize the benchmark metrics' },
    );

    expect(response.content).toBe(
      'Grounding answer based on the uploaded paper.',
    );
    expect(response.sources).toEqual([
      { source: 'vec-doc-sync-789 (p.1)', title: 'Quantum ML', page: 1 },
    ]);
    expect(mockEngine.chatSync).toHaveBeenCalledTimes(1);
    expect(mockEngine.chatSync.mock.calls[0][0].document_ids).toEqual([
      'vec-doc-sync-789',
    ]);
  });

  it('falls back transparently to LibraryItem when ID belongs to library catalog', async () => {
    mockPrisma.libraryItem.findFirst.mockResolvedValue({
      id: 'library-item-999',
      title: 'Attention Is All You Need',
      createdById: 'user-researcher-1',
      spaceId: 'user-researcher-1',
      contributors: [{ fullName: 'Vaswani et al.' }],
      attachments: [],
      year: 2017,
      metadata: { ragDocId: 'vec-doc-vaswani' },
    });

    await paperService.stream(
      'user-researcher-1',
      'library-item-999',
      { query: 'Explain multi-head attention' },
      mockReply,
    );

    expect(mockEngine.chatStream).toHaveBeenCalledTimes(1);
    expect(mockEngine.chatStream.mock.calls[0][0].document_ids).toEqual([
      'vec-doc-vaswani',
    ]);
  });

  it('throws NotFoundException when ID matches neither LibraryItem, StorageFile, nor Attachment', async () => {
    await expect(
      paperService.stream(
        'user-1',
        'non-existent-id',
        { query: 'Hello?' },
        mockReply,
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
