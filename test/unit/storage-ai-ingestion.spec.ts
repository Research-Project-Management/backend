import { FileUploadedAiListener } from '@/modules/ai/ingestion/listeners/file-uploaded-ai.listener';
import { DocumentAiIngestionService } from '@/modules/ai/ingestion/services/document-ai-ingestion.service';
import { ScientificChunkingService } from '@/modules/ai/ingestion/services/scientific-chunking.service';
import { FileUploadedEvent } from '@/modules/storage/domain/events/file-uploaded.event';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { IContentFacade } from '@/modules/library/reader/reader.facade';
import { EngineService } from '@/modules/ai/engine/engine.service';
import { PrismaService } from '@/core/database/prisma.service';

describe('Storage AI RAG Ingestion Pipeline Suite', () => {
  let listener: FileUploadedAiListener;
  let ingestionService: DocumentAiIngestionService;
  let mockPrisma: any;
  let mockStoragePort: jest.Mocked<IStoragePort>;
  let mockContentFacade: any;
  let mockEngineService: any;
  let chunkingService: ScientificChunkingService;

  beforeEach(() => {
    mockPrisma = {
      file: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    mockStoragePort = {
      readOwnedFile: jest.fn(),
      linkFile: jest.fn(),
      uploadFile: jest.fn(),
      uploadBuffer: jest.fn(),
    };

    mockContentFacade = {
      extractDocumentFromBuffer: jest.fn(),
    };

    mockEngineService = {
      uploadDocument: jest.fn(),
    };

    chunkingService = new ScientificChunkingService();

    ingestionService = new DocumentAiIngestionService(
      mockPrisma as PrismaService,
      mockStoragePort,
      mockContentFacade as IContentFacade,
      chunkingService,
      mockEngineService as EngineService,
    );

    listener = new FileUploadedAiListener(ingestionService);
  });

  it('should ignore non-scientific/non-textual files (e.g. images, archives)', async () => {
    const event = new FileUploadedEvent(
      'file-image-123',
      'blob-1',
      'user-1',
      'figure.png',
      'image/png',
      1024n,
      'blobs/fig.png',
    );

    const ingestSpy = jest.spyOn(ingestionService, 'ingestFile');
    await listener.handleFileUploaded(event);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
  });

  it('should process scientific PDF and index into AI vector database upon file.uploaded event', async () => {
    const fileId = 'file-paper-456';
    const event = new FileUploadedEvent(
      fileId,
      'blob-2',
      'user-1',
      'quantum_computing.pdf',
      'application/pdf',
      2048n,
      'blobs/qc.pdf',
      'project-physics',
    );

    mockPrisma.file.findUnique.mockResolvedValue({
      id: fileId,
      trashedAt: null,
      metaData: {},
    });

    mockStoragePort.readOwnedFile.mockResolvedValue({
      fileId,
      filename: 'quantum_computing.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      storageKey: 'blobs/qc.pdf',
      contentUrl: `/api/files/${fileId}/content`,
      buffer: Buffer.from('%PDF-1.7 sample quantum paper data'),
    });

    mockContentFacade.extractDocumentFromBuffer.mockResolvedValue({
      metadata: {
        title: 'Quantum Advantage in Scientific Simulation',
        authors: ['Alice Researcher', 'Bob Physicist'],
        doi: '10.1103/PhysRevA.99.000000',
        year: 2024,
        abstract:
          'We demonstrate quantum speedup for molecular Hamiltonian simulation.',
      },
      pages: [
        {
          pageIndex: 0,
          charOffset: 0,
          textContent:
            '1. Introduction\nQuantum computers offer polynomial speedups.',
        },
      ],
      sections: [],
    });

    mockEngineService.uploadDocument.mockResolvedValue({
      id: 'rag-vector-doc-999',
      status: 'indexed',
    });

    await listener.handleFileUploaded(event);

    // Verify storage read
    expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({
      fileId,
      userId: 'user-1',
      projectId: 'project-physics',
    });

    // Verify PDF extraction
    expect(mockContentFacade.extractDocumentFromBuffer).toHaveBeenCalled();

    // Verify AI Engine vector upload
    expect(mockEngineService.uploadDocument).toHaveBeenCalledWith(
      expect.any(Buffer),
      'text/markdown',
      'quantum_computing.pdf.md',
      expect.objectContaining({
        title: 'Quantum Advantage in Scientific Simulation',
        userId: 'user-1',
        projectId: 'project-physics',
      }),
    );

    // Verify Prisma metadata update
    expect(mockPrisma.file.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: fileId },
        data: expect.objectContaining({
          metaData: expect.objectContaining({
            ragStatus: 'indexed',
            ragDocId: 'rag-vector-doc-999',
            title: 'Quantum Advantage in Scientific Simulation',
            doi: '10.1103/PhysRevA.99.000000',
          }),
        }),
      }),
    );
  });

  it('should skip ingestion if document is already indexed (idempotency)', async () => {
    const fileId = 'file-already-indexed';
    const event = new FileUploadedEvent(
      fileId,
      'blob-3',
      'user-1',
      'existing_paper.pdf',
      'application/pdf',
      2048n,
      'blobs/exist.pdf',
    );

    mockPrisma.file.findUnique.mockResolvedValue({
      id: fileId,
      trashedAt: null,
      metaData: {
        ragStatus: 'indexed',
        ragDocId: 'existing-rag-id',
      },
    });

    await listener.handleFileUploaded(event);

    expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
    expect(mockEngineService.uploadDocument).not.toHaveBeenCalled();
  });

  it('should handle AI engine offline failure gracefully by recording ragStatus failed and keeping local metadata', async () => {
    const fileId = 'file-offline-test';
    const event = new FileUploadedEvent(
      fileId,
      'blob-4',
      'user-1',
      'offline_paper.pdf',
      'application/pdf',
      2048n,
      'blobs/offline.pdf',
    );

    mockPrisma.file.findUnique.mockResolvedValue({
      id: fileId,
      trashedAt: null,
      metaData: {},
    });

    mockStoragePort.readOwnedFile.mockResolvedValue({
      fileId,
      filename: 'offline_paper.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      storageKey: 'blobs/offline.pdf',
      contentUrl: `/api/files/${fileId}/content`,
      buffer: Buffer.from('%PDF-1.7 sample data'),
    });

    mockContentFacade.extractDocumentFromBuffer.mockResolvedValue({
      metadata: {
        title: 'Offline Scientific Paper',
        authors: ['Carol Scientist'],
      },
      pages: [
        {
          pageIndex: 0,
          charOffset: 0,
          textContent: 'Content for offline paper',
        },
      ],
      sections: [],
    });

    // Simulate AI Engine being offline
    mockEngineService.uploadDocument.mockRejectedValue(
      new Error('Connection refused: http://localhost:8000/documents/upload'),
    );

    await listener.handleFileUploaded(event);

    // Verify Prisma updated with failed status but local extracted metadata preserved
    expect(mockPrisma.file.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: fileId },
        data: expect.objectContaining({
          metaData: expect.objectContaining({
            ragStatus: 'failed',
            title: 'Offline Scientific Paper',
          }),
        }),
      }),
    );
  });
});
