import { fromPartial } from '@total-typescript/shoehorn';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { PrismaService } from '@/core';
import {
  FileTrashedEvent,
  FileUploadedEvent,
  type IExperimentsPort,
} from '@/modules/experiments';
import type { ILibraryFacade } from '@/modules/library/library.module';
import { AI_JOB_INGEST_FILE } from '@/modules/ai/ai.constant';
import { AccessRepository } from '@/modules/ai/access/access.repository';
import { AccessService } from '@/modules/ai/access/services/access.service';
import { DocumentAccessService } from '@/modules/ai/access/services/document.service';
import { SpaceAccessService } from '@/modules/ai/access/services/space.service';
import type { IAiEnginePort } from '@/modules/ai/engine/engine.port';
import { KnowledgeRepository } from '@/modules/ai/knowledge/knowledge.repository';
import { KnowledgeEventListener } from '@/modules/ai/knowledge/processors/knowledge.listener';
import { KnowledgeQueueProducer } from '@/modules/ai/knowledge/processors/knowledge.producer';
import { KnowledgeIngestService } from '@/modules/ai/knowledge/services/ingest.service';

interface StorageFileUpdateArgs {
  where: { id: string };
  data: { metadata: Record<string, unknown> };
}

describe('Storage AI Knowledge Sync & BullMQ Ingestion Suite', () => {
  let listener: KnowledgeEventListener;
  let ingestService: KnowledgeIngestService;
  let mockPrisma: {
    space: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    project: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    aiChat: { findFirst: jest.Mock<Promise<unknown>, [unknown?]> };
    fileNode: {
      findUnique: jest.Mock<Promise<unknown>, [unknown?]>;
      update: jest.Mock<Promise<unknown>, [StorageFileUpdateArgs]>;
    };
  };
  let mockStoragePort: jest.Mocked<IExperimentsPort>;
  let mockLibraryFacade: {
    extractDocumentFromBuffer: jest.Mock<
      Promise<unknown>,
      [unknown?, unknown?]
    >;
    findAttachmentByFileId: jest.Mock<Promise<unknown>, [unknown?, unknown?]>;
    updateAttachmentProcessingStatus: jest.Mock<Promise<unknown>, unknown[]>;
    updateItemAiMetadata: jest.Mock<Promise<unknown>, unknown[]>;
  };
  let mockEngine: jest.Mocked<IAiEnginePort>;

  beforeEach(() => {
    mockPrisma = {
      space: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      project: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      aiChat: {
        findFirst: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
      },
      fileNode: {
        findUnique: jest.fn<Promise<unknown>, [unknown?]>(async () => null),
        update: jest.fn<Promise<unknown>, [StorageFileUpdateArgs]>(
          async () => ({}),
        ),
      },
    };

    mockStoragePort = fromPartial<jest.Mocked<IExperimentsPort>>({
      readOwnedFile: jest.fn(),
    });

    mockLibraryFacade = {
      extractDocumentFromBuffer: jest.fn<
        Promise<unknown>,
        [unknown?, unknown?]
      >(async () => null),
      findAttachmentByFileId: jest.fn<Promise<unknown>, [unknown?, unknown?]>(
        async () => null,
      ),
      updateAttachmentProcessingStatus: jest.fn<Promise<unknown>, unknown[]>(
        async () => undefined,
      ),
      updateItemAiMetadata: jest.fn<Promise<unknown>, unknown[]>(
        async () => undefined,
      ),
    };

    mockEngine = {
      health: jest.fn(),
      listAgents: jest.fn(),
      listModels: jest.fn(),
      chatSync: jest.fn(),
      chatStream: jest.fn(),
      resumeSync: jest.fn(),
      resumeStream: jest.fn(),
      cancelThread: jest.fn(),
      deleteThread: jest.fn(),
      deleteSpaceThreads: jest.fn(),
      ingestDocument: jest.fn(),
      searchKnowledge: jest.fn(),
      deleteKnowledgeSource: jest.fn().mockResolvedValue({
        space_id: 'project-physics',
        deleted: true,
      }),
    };

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

  listener = new KnowledgeEventListener(ingestService, undefined, eagerConfig);
  });

  it('ignores non-textual files such as images and archives', async () => {
    const event = new FileUploadedEvent(
      'file-image-123',
      'blob-1',
      'user-1',
      'figure.png',
      'image/png',
      BigInt(1024),
      'blobs/fig.png',
    );

    const ingestSpy = jest.spyOn(ingestService, 'ingestStorageFile');
    await listener.handleFileUploaded(event);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
  });

  it('forwards raw PDF bytes directly to Python /knowledge/ingest and preserves page-level indexing', async () => {
    const fileId = 'file-paper-456';
    const pdfBytes = Buffer.from('%PDF-1.7 sample quantum paper data');
    const event = new FileUploadedEvent(
      fileId,
      'blob-2',
      'user-1',
      'quantum_computing.pdf',
      'application/pdf',
      BigInt(2048),
      'blobs/qc.pdf',
      'project-physics',
    );

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
        abstract: 'Molecular Hamiltonian speedup.',
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

    await listener.handleFileUploaded(event);

    expect(mockEngine.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: 'space-physics-uuid',
        sourceType: 'file',
        sourceId: fileId,
        fileBuffer: pdfBytes,
        filename: 'quantum_computing.pdf',
        mimeType: 'application/pdf',
        title: 'Quantum Advantage in Scientific Simulation',
      }),
    );

    const updateCalls = mockPrisma.fileNode.update.mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1]?.[0];
    expect(lastUpdate?.where).toEqual({ id: fileId });
    expect(lastUpdate?.data.metadata).toEqual(
      expect.objectContaining({
        ragStatus: 'indexed',
        ragDocId: fileId,
        chunkCount: 6,
        pageCount: 2,
        doi: '10.1103/PhysRevA.99.000000',
      }),
    );
  });

  it('enqueues BullMQ job when KnowledgeQueueProducer is configured', async () => {
    const queueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
    const mockQueue = fromPartial<Queue>({
      add: queueAdd,
      on: jest.fn(),
    });
    const producer = new KnowledgeQueueProducer(mockQueue);
    const queuedListener = new KnowledgeEventListener(
      ingestService,
      producer,
      fromPartial<ConfigService>({
        get: jest.fn((key: string) =>
          key === 'FLUX_AI_EAGER_INGEST_ON_UPLOAD' || key === 'FLUX_AI_ENABLED'
            ? 'true'
            : undefined,
        ),
      }),
    );

    const event = new FileUploadedEvent(
      'file-queued-1',
      'blob-q',
      'user-1',
      'paper.pdf',
      'application/pdf',
      BigInt(512),
      'blobs/q.pdf',
      'space-1',
    );

    await queuedListener.handleFileUploaded(event);

    expect(queueAdd).toHaveBeenCalledWith(
      AI_JOB_INGEST_FILE,
      expect.objectContaining({
        fileId: 'file-queued-1',
        filename: 'paper.pdf',
      }),
      expect.objectContaining({ jobId: 'ai-ingest-file-queued-1' }),
    );
    expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
  });

  it('skips ingestion when document is already indexed (idempotency)', async () => {
    const fileId = 'file-already-indexed';
    const event = new FileUploadedEvent(
      fileId,
      'blob-3',
      'user-1',
      'existing_paper.pdf',
      'application/pdf',
      BigInt(2048),
      'blobs/exist.pdf',
    );

    mockPrisma.fileNode.findUnique.mockResolvedValue({
      id: fileId,
      deletedAt: null,
      metadata: {
        ragStatus: 'indexed',
        ragDocId: 'existing-rag-id',
      },
    });

    await listener.handleFileUploaded(event);

    expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
    expect(mockEngine.ingestDocument).not.toHaveBeenCalled();
  });

  it('removes indexed knowledge vectors when a file is trashed', async () => {
    mockPrisma.fileNode.findUnique.mockResolvedValue({
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
  });

  it('records ragStatus failed while preserving bib metadata if AI engine is offline', async () => {
    const fileId = 'file-offline-test';
    const event = new FileUploadedEvent(
      fileId,
      'blob-4',
      'user-1',
      'offline_paper.pdf',
      'application/pdf',
      BigInt(2048),
      'blobs/offline.pdf',
    );

    mockPrisma.fileNode.findUnique.mockResolvedValue({
      id: fileId,
      spaceId: 'user-1',
      deletedAt: null,
      metadata: {},
    });

    mockStoragePort.readOwnedFile.mockResolvedValue({
      fileId,
      filename: 'offline_paper.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      storageKey: 'blobs/offline.pdf',
      contentUrl: `/api/v1/experiments/files/${fileId}/content`,
      buffer: Buffer.from('%PDF-1.7 sample data'),
    });

    mockLibraryFacade.extractDocumentFromBuffer.mockResolvedValue({
      metadata: {
        title: 'Offline Scientific Paper',
        authors: ['Carol Scientist'],
      },
      pages: [{ pageIndex: 0 }],
      sections: [],
    });

    mockEngine.ingestDocument.mockRejectedValue(
      new Error(
        'AI service unreachable: http://127.0.0.1:18420/knowledge/ingest',
      ),
    );

    await listener.handleFileUploaded(event);

    const updateCalls = mockPrisma.fileNode.update.mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1]?.[0];
    expect(lastUpdate?.where).toEqual({ id: fileId });
    expect(lastUpdate?.data.metadata).toEqual(
      expect.objectContaining({
        ragStatus: 'failed',
        title: 'Offline Scientific Paper',
      }),
    );
  });

  it('skips eager upload ingestion by default in pure on-demand mode', async () => {
    const defaultListener = new KnowledgeEventListener(ingestService);
    const event = new FileUploadedEvent(
      'file-ondemand-1',
      'blob-od',
      'user-1',
      'paper.pdf',
      'application/pdf',
      BigInt(1024),
      'blobs/paper.pdf',
      'space-1',
    );

    await defaultListener.handleFileUploaded(event);

    expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
    expect(mockEngine.ingestDocument).not.toHaveBeenCalled();
  });
});
