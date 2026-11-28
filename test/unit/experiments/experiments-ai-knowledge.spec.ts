import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Queue } from 'bullmq';
import type { FastifyReply } from 'fastify';
import type { PrismaService } from '@/core';
import {
  FileTrashedEvent,
  FileUploadedEvent,
  type IExperimentsPort,
} from '@/modules/experiments';
import type { ILibraryFacade } from '@/modules/library';
import { AI_JOB_INGEST_FILE } from '@/modules/ai/ai.constant';
import { AccessRepository } from '@/modules/ai/access/access.repository';
import { AccessService } from '@/modules/ai/access/services/access.service';
import { DocumentAccessService } from '@/modules/ai/access/services/document.service';
import { SpaceAccessService } from '@/modules/ai/access/services/space.service';
import type { ChatService } from '@/modules/ai/chat/services/chat.service';
import { PaperChatService } from '@/modules/ai/chat/services/paper.service';
import type { IAiEnginePort } from '@/modules/ai/engine/engine.port';
import { KnowledgeRepository } from '@/modules/ai/knowledge/knowledge.repository';
import { KnowledgeEventListener } from '@/modules/ai/knowledge/processors/knowledge.listener';
import { KnowledgeQueueProducer } from '@/modules/ai/knowledge/processors/knowledge.producer';
import { KnowledgeIngestService } from '@/modules/ai/knowledge/services/ingest.service';

interface StorageFileUpdateArgs {
  where: { id: string };
  data: { metadata: Record<string, unknown> };
}

describe('Experiments AI Knowledge Ingestion & Paper RAG Q&A Suite', () => {
  let listener: KnowledgeEventListener;
  let ingestService: KnowledgeIngestService;
  let paperService: PaperChatService;
  let mockPrisma: {
    space: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    project: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    projectMember: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    aiChat: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    libraryItem: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    attachment: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    fileNode: {
      findFirst: jest.Mock<Promise<unknown>, [unknown?]>;
      findUnique: jest.Mock<Promise<unknown>, [unknown?]>;
      update: jest.Mock<Promise<unknown>, [StorageFileUpdateArgs]>;
    };
  };
  let mockStoragePort: jest.Mocked<IExperimentsPort>;
  let mockLibraryFacade: {
    extractDocumentFromBuffer: jest.Mock<Promise<unknown>, [unknown?, unknown?]>;
    findAttachmentByFileId: jest.Mock<Promise<unknown>, [unknown?, unknown?]>;
    updateAttachmentProcessingStatus: jest.Mock<Promise<unknown>, unknown[]>;
    updateItemAiMetadata: jest.Mock<Promise<unknown>, unknown[]>;
  };
  let mockEngine: jest.Mocked<IAiEnginePort>;
  let mockReply: FastifyReply;

  beforeEach(() => {
    mockPrisma = {
      space: { findFirst: jest.fn(async () => null) },
      project: { findFirst: jest.fn(async () => null) },
      projectMember: { findFirst: jest.fn(async () => null) },
      aiChat: { findFirst: jest.fn(async () => null) },
      libraryItem: { findFirst: jest.fn(async () => null) },
      attachment: { findFirst: jest.fn(async () => null) },
      fileNode: {
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(async () => null),
        update: jest.fn<Promise<unknown>, [StorageFileUpdateArgs]>(
          async () => ({}),
        ),
      },
    };

    mockStoragePort = fromPartial<jest.Mocked<IExperimentsPort>>({
      readOwnedFile: jest.fn(),
    });

    mockLibraryFacade = {
      extractDocumentFromBuffer: jest.fn(async () => null),
      findAttachmentByFileId: jest.fn(async () => null),
      updateAttachmentProcessingStatus: jest.fn(async () => undefined),
      updateItemAiMetadata: jest.fn(async () => undefined),
    };

    mockEngine = fromPartial<jest.Mocked<IAiEnginePort>>({
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
      ingestDocument: jest.fn(),
      deleteKnowledgeSource: jest.fn().mockResolvedValue({
        space_id: 'project-physics',
        deleted: true,
      }),
    });

    const prismaService = fromPartial<PrismaService>(mockPrisma);
    const accessRepo = new AccessRepository(prismaService);
    const spaceAccess = new SpaceAccessService(accessRepo);
    const docAccess = new DocumentAccessService(accessRepo, spaceAccess);
    const accessService = new AccessService(spaceAccess, docAccess);

    const knowledgeRepo = new KnowledgeRepository(prismaService);
    ingestService = new KnowledgeIngestService(
      knowledgeRepo,
      mockEngine,
      accessService,
      mockStoragePort,
      fromPartial<ILibraryFacade>(mockLibraryFacade),
    );

    const eagerConfig = fromPartial<ConfigService>({
      get: jest.fn((key: string) =>
        key === 'FLUX_AI_EAGER_INGEST_ON_UPLOAD' || key === 'FLUX_AI_ENABLED'
          ? 'true'
          : undefined,
      ),
    });
    listener = new KnowledgeEventListener(
      ingestService,
      undefined,
      eagerConfig,
    );

    const buildRequest = (
      dto: { query: string; spaceId?: string; documentIds?: string[] },
      options?: { prependSystemMessage?: string },
    ) => ({
      space_id: dto.spaceId,
      document_ids: dto.documentIds,
      intent_hint: 'rag_agent',
      messages: [
        { role: 'system', content: options?.prependSystemMessage ?? '' },
        { role: 'user', content: dto.query },
      ],
    });
    const chatServiceStub = fromPartial<ChatService>({
      stream: jest.fn(async (_userId, dto, _reply, _token, options) => {
        await mockEngine.chatStream(
          buildRequest(dto, options) as never,
          {} as never,
        );
      }),
      execute: jest.fn(async (_userId, dto, _token, options) =>
        mockEngine.chatSync(buildRequest(dto, options) as never) as never,
      ),
    });
    paperService = new PaperChatService(chatServiceStub, accessService);
    mockReply = fromPartial<FastifyReply>({ raw: {}, hijack: jest.fn() });
  });

  describe('KnowledgeEventListener & KnowledgeIngestService', () => {
    it('skips non-textual uploads, already-indexed files, and default on-demand uploads', async () => {
      await listener.handleFileUploaded(
        new FileUploadedEvent(
          'file-image-123',
          'blob-1',
          'user-1',
          'figure.png',
          'image/png',
          1024n,
          'blobs/fig.png',
        ),
      );

      mockPrisma.fileNode.findUnique.mockResolvedValueOnce({
        id: 'file-already-indexed',
        deletedAt: null,
        metadata: { ragStatus: 'indexed', ragDocId: 'existing-rag-id' },
      });
      await listener.handleFileUploaded(
        new FileUploadedEvent(
          'file-already-indexed',
          'blob-3',
          'user-1',
          'existing_paper.pdf',
          'application/pdf',
          2048n,
          'blobs/exist.pdf',
        ),
      );

      const defaultListener = new KnowledgeEventListener(ingestService);
      await defaultListener.handleFileUploaded(
        new FileUploadedEvent(
          'file-ondemand-1',
          'blob-od',
          'user-1',
          'paper.pdf',
          'application/pdf',
          1024n,
          'blobs/paper.pdf',
          'space-1',
        ),
      );

      expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
      expect(mockEngine.ingestDocument).not.toHaveBeenCalled();
    });

    it('ingests PDF bytes into Python /knowledge/ingest, persists RAG metadata, and enqueues BullMQ jobs when producer is present', async () => {
      const fileId = 'file-paper-456';
      const pdfBytes = Buffer.from('%PDF-1.7 sample quantum paper data');
      mockPrisma.fileNode.findUnique.mockResolvedValue({
        id: fileId,
        spaceId: 'space-physics-uuid',
        deletedAt: null,
        metadata: {},
      });
      mockStoragePort.readOwnedFile.mockResolvedValue({
        fileId,
        filename: 'quantum_computing.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        storageKey: 'blobs/qc.pdf',
        contentUrl: `/api/v1/experiments/files/${fileId}/content`,
        buffer: pdfBytes,
      });
      mockLibraryFacade.extractDocumentFromBuffer.mockResolvedValue({
        metadata: {
          title: 'Quantum Advantage in Scientific Simulation',
          authors: ['Alice Researcher', 'Bob Physicist'],
          doi: '10.1103/PhysRevA.99.000000',
          year: 2024,
        },
        pages: [{ pageIndex: 0 }, { pageIndex: 1 }],
        sections: [],
      });
      mockEngine.ingestDocument.mockResolvedValue({
        space_id: 'space-physics-uuid',
        source_type: 'file',
        source_id: fileId,
        title: 'Quantum Advantage in Scientific Simulation',
        pages_parsed: 2,
        chunks_indexed: 6,
      });

      await listener.handleFileUploaded(
        new FileUploadedEvent(
          fileId,
          'blob-2',
          'user-1',
          'quantum_computing.pdf',
          'application/pdf',
          2048n,
          'blobs/qc.pdf',
          'project-physics',
        ),
      );

      expect(mockEngine.ingestDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: 'space-physics-uuid',
          sourceType: 'file',
          sourceId: fileId,
          fileBuffer: pdfBytes,
          title: 'Quantum Advantage in Scientific Simulation',
        }),
      );
      const updateCalls = mockPrisma.fileNode.update.mock.calls;
      const lastUpdate =
        updateCalls[updateCalls.length - 1]?.[0]?.data.metadata;
      expect(lastUpdate).toMatchObject({
        ragStatus: 'indexed',
        ragDocId: fileId,
        chunkCount: 6,
        pageCount: 2,
        doi: '10.1103/PhysRevA.99.000000',
      });

      // BullMQ queue producer branch
      const queueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
      const queuedListener = new KnowledgeEventListener(
        ingestService,
        new KnowledgeQueueProducer(
          fromPartial<Queue>({ add: queueAdd, on: jest.fn() }),
        ),
        fromPartial<ConfigService>({
          get: jest.fn((key: string) =>
            key === 'FLUX_AI_EAGER_INGEST_ON_UPLOAD' ||
            key === 'FLUX_AI_ENABLED'
              ? 'true'
              : undefined,
          ),
        }),
      );
      await queuedListener.handleFileUploaded(
        new FileUploadedEvent(
          'file-queued-1',
          'blob-q',
          'user-1',
          'paper.pdf',
          'application/pdf',
          512n,
          'blobs/q.pdf',
          'space-1',
        ),
      );
      expect(queueAdd).toHaveBeenCalledWith(
        AI_JOB_INGEST_FILE,
        expect.objectContaining({ fileId: 'file-queued-1', filename: 'paper.pdf' }),
        expect.objectContaining({ jobId: 'ai-ingest-file-queued-1' }),
      );
    });

    it('deletes knowledge vectors on file.trashed and preserves bib metadata when AI engine is offline', async () => {
      mockPrisma.fileNode.findUnique.mockResolvedValueOnce({
        id: 'file-trashed-1',
        spaceId: 'space-1',
        metadata: { ragDocId: 'vec-trashed-1' },
      });
      await listener.handleFileTrashed(
        new FileTrashedEvent('file-trashed-1', 'user-1', new Date(), 'space-1'),
      );
      expect(mockEngine.deleteKnowledgeSource).toHaveBeenCalledWith(
        'space-1',
        'file',
        'vec-trashed-1',
      );

      const offlineId = 'file-offline-test';
      mockPrisma.fileNode.findUnique.mockResolvedValueOnce({
        id: offlineId,
        spaceId: 'user-1',
        deletedAt: null,
        metadata: {},
      });
      mockStoragePort.readOwnedFile.mockResolvedValueOnce({
        fileId: offlineId,
        filename: 'offline_paper.pdf',
        mimeType: 'application/pdf',
        size: 2048,
        storageKey: 'blobs/offline.pdf',
        contentUrl: `/api/v1/experiments/files/${offlineId}/content`,
        buffer: Buffer.from('%PDF-1.7 sample data'),
      });
      mockLibraryFacade.extractDocumentFromBuffer.mockResolvedValueOnce({
        metadata: { title: 'Offline Scientific Paper', authors: ['Carol'] },
        pages: [{ pageIndex: 0 }],
        sections: [],
      });
      mockEngine.ingestDocument.mockRejectedValueOnce(
        new Error('AI service unreachable'),
      );

      await listener.handleFileUploaded(
        new FileUploadedEvent(
          offlineId,
          'blob-4',
          'user-1',
          'offline_paper.pdf',
          'application/pdf',
          2048n,
          'blobs/offline.pdf',
        ),
      );
      const offlineCalls = mockPrisma.fileNode.update.mock.calls;
      expect(
        offlineCalls[offlineCalls.length - 1]?.[0]?.data.metadata,
      ).toMatchObject({
        ragStatus: 'failed',
        title: 'Offline Scientific Paper',
      });
    });
  });

  describe('PaperChatService & AccessService RAG Q&A', () => {
    it('streams and executes grounded Q&A for StorageFile and LibraryItem, enforcing 403/404 boundaries', async () => {
      mockPrisma.fileNode.findFirst.mockResolvedValueOnce({
        id: 'file-storage-pdf-001',
        filename: 'quantum_computing.pdf',
        createdById: 'user-researcher-1',
        spaceId: 'space-qml',
        linkedToType: 'project',
        linkedToId: 'project-qml',
        sharedWith: [],
        metadata: {
          title: 'Quantum Computing and Machine Learning Synergy',
          authors: ['Dr. Alice Walker'],
          abstract: 'Hybrid quantum-classical algorithms.',
          ragDocId: 'vec-doc-quantum-456',
        },
      });

      await paperService.stream(
        'user-researcher-1',
        'file-storage-pdf-001',
        { query: 'What is the main advantage?' },
        mockReply,
      );
      const [streamReq] = mockEngine.chatStream.mock.calls[0];
      expect(streamReq.space_id).toBe('space-qml');
      expect(streamReq.document_ids).toEqual(['vec-doc-quantum-456']);
      expect(
        streamReq.messages.find((m) => m.role === 'system')?.content,
      ).toContain('Quantum Computing and Machine Learning Synergy');

      // Synchronous Q&A
      mockPrisma.fileNode.findFirst.mockResolvedValueOnce({
        id: 'file-sync-456',
        filename: 'benchmark_results.pdf',
        createdById: 'user-researcher-1',
        spaceId: 'user-researcher-1',
        linkedToType: null,
        linkedToId: null,
        sharedWith: [],
        metadata: {
          title: 'Benchmark Results',
          ragDocId: 'vec-doc-sync-789',
        },
      });
      const syncRes = await paperService.execute(
        'user-researcher-1',
        'file-sync-456',
        { query: 'Summarize metrics' },
      );
      expect(syncRes.content).toBe(
        'Grounding answer based on the uploaded paper.',
      );

      // LibraryItem fallback
      mockPrisma.libraryItem.findFirst.mockResolvedValueOnce({
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
      const streamCalls = mockEngine.chatStream.mock.calls;
      expect(streamCalls[streamCalls.length - 1]?.[0].document_ids).toEqual([
        'vec-doc-vaswani',
      ]);

      // Unauthorized StorageFile -> 403
      mockPrisma.fileNode.findFirst.mockResolvedValueOnce({
        id: 'file-private-123',
        filename: 'confidential.pdf',
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
          { query: 'Secret?' },
          mockReply,
        ),
      ).rejects.toThrow(ForbiddenException);

      // Missing ID -> 404
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
});
