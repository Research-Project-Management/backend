import { Test, TestingModule } from '@nestjs/testing';
import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { IdentifyStage } from '@/modules/library/ingestion/stages/identify.stage';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { PipelineService } from '@/modules/library/ingestion/services/pipeline.service';
import { QueueService } from '@/modules/library/ingestion/services/queue.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { DoiParser } from '@/modules/library/ingestion/parsers/doi.parser';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { IngestionSubmissionEnvelope } from '@/modules/library/ingestion/types/submission.types';
import zlib from 'zlib';

describe('Library Ingestion Claim Check Pattern & Scale Optimizations', () => {
  let ingestionService: IngestionService;
  let identifyStage: IdentifyStage;
  let mockStoragePort: jest.Mocked<IStoragePort>;
  let mockRepo: any;
  let mockQueue: any;

  const sampleBibtexSmall = `@article{einstein1905,
    title={Zur Elektrodynamik bewegter Korper},
    author={Einstein, Albert},
    journal={Annalen der Physik},
    year={1905}
  }`;

  // Generate a large BibTeX payload (> 35KB)
  const generateLargeBibtex = (count: number) => {
    let result = '';
    for (let i = 0; i < count; i++) {
      result += `@article{paper_${i},
  title={Scalable Distributed Computing in Scientific Architecture Paper ${i}},
  author={Author Alpha and Author Beta and Author Gamma},
  journal={Journal of High Performance Systems},
  year={2026},
  volume={42},
  pages={100--150},
  abstract={A comprehensive deep dive into scalable distributed systems, claim check messaging, and high-throughput pipelines. Paper number ${i} provides thorough evaluation.},
  doi={10.1000/182.large.scale.${i}}
}\n\n`;
    }
    return result;
  };

  const storedFiles = new Map<string, { buffer: Buffer; filename: string }>();

  beforeEach(async () => {
    storedFiles.clear();

    mockStoragePort = {
      uploadFile: jest.fn().mockImplementation(async (input) => {
        const fileId = `file-claim-check-${Date.now()}`;
        storedFiles.set(fileId, {
          buffer: input.buffer,
          filename: input.filename,
        });
        return {
          fileId,
          url: `/api/files/${fileId}/content`,
          path: `storage/${input.filename}`,
          filename: input.filename,
          size: input.buffer.length,
          mimeType: input.mimeType,
        };
      }),
      readOwnedFile: jest.fn().mockImplementation(async (input) => {
        const entry = storedFiles.get(input.fileId);
        if (!entry) throw new Error(`File ${input.fileId} not found`);
        return {
          fileId: input.fileId,
          filename: entry.filename,
          mimeType: 'application/gzip',
          size: entry.buffer.length,
          storageKey: `storage/${entry.filename}`,
          contentUrl: `/api/files/${input.fileId}/content`,
          buffer: entry.buffer,
        };
      }),
      linkFile: jest.fn().mockResolvedValue(undefined),
    };

    mockRepo = {
      findRunByIdempotencyKey: jest.fn().mockResolvedValue(null),
      createRun: jest.fn().mockImplementation((scope, data) => ({
        id: 'run-uuid-1234',
        userId: scope.userId,
        projectId: scope.projectId,
        status: 'PENDING',
        inputParams: data.inputParams,
        inputHash: data.inputHash,
        startedAt: new Date(),
      })),
      findRunById: jest.fn().mockResolvedValue(null),
      updateRunProgress: jest.fn().mockResolvedValue(undefined),
      updateRunStatus: jest.fn().mockResolvedValue(undefined),
      createCandidate: jest.fn().mockResolvedValue(undefined),
    };

    mockQueue = {
      enqueue: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IngestionService,
        IdentifyStage,
        DoiParser,
        BibtexParser,
        RisParser,
        NormalizationPolicy,
        { provide: IngestionRepository, useValue: mockRepo },
        { provide: QueueService, useValue: mockQueue },
        { provide: PipelineService, useValue: {} },
        { provide: UrlCaptureService, useValue: {} },
        { provide: STORAGE_PORT, useValue: mockStoragePort },
      ],
    }).compile();

    ingestionService = module.get<IngestionService>(IngestionService);
    identifyStage = module.get<IdentifyStage>(IdentifyStage);
  });

  describe('Claim Check Pattern in IngestionService', () => {
    it('should keep small BibTeX records inline without offloading to storage', async () => {
      const envelope: IngestionSubmissionEnvelope = {
        userId: 'user-uuid-1',
        projectId: 'proj-uuid-1',
        payload: {
          kind: 'RECORD',
          format: 'BIBTEX',
          content: sampleBibtexSmall,
        },
      };

      const result = await ingestionService.submit(envelope);

      expect(result.runId).toBe('run-uuid-1234');
      expect(mockStoragePort.uploadFile).not.toHaveBeenCalled();
      expect(mockRepo.createRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          inputParams: expect.objectContaining({
            payload: expect.objectContaining({
              kind: 'RECORD',
              content: sampleBibtexSmall,
            }),
          }),
        }),
      );
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'run-uuid-1234',
        'proj-uuid-1',
        expect.objectContaining({
          payload: expect.objectContaining({
            kind: 'RECORD',
            content: sampleBibtexSmall,
          }),
        }),
      );
    });

    it('should offload large BibTeX records (> 32KB) to StoragePort using Claim Check', async () => {
      const largeContent = generateLargeBibtex(80); // ~40KB
      expect(largeContent.length).toBeGreaterThan(32 * 1024);

      const envelope: IngestionSubmissionEnvelope = {
        userId: 'user-uuid-1',
        projectId: 'proj-uuid-1',
        payload: {
          kind: 'RECORD',
          format: 'BIBTEX',
          content: largeContent,
        },
      };

      const result = await ingestionService.submit(envelope);

      expect(result.runId).toBe('run-uuid-1234');
      expect(mockStoragePort.uploadFile).toHaveBeenCalledTimes(1);

      // Verify inputParams in DB only stores Claim Check reference, not the 40KB text
      const passedCreateRunData = mockRepo.createRun.mock.calls[0][1];
      const savedPayload = passedCreateRunData.inputParams.payload;

      expect(savedPayload.isOffloaded).toBe(true);
      expect(savedPayload.fileId).toBeDefined();
      expect(savedPayload.uncompressedSize).toBe(largeContent.length);
      expect(savedPayload.byteSize).toBeLessThan(largeContent.length); // Compressed
      expect(savedPayload.content).toBeUndefined(); // Raw content stripped from DB JSONB

      // Verify Queue job only receives Claim Check token (lightweight BullMQ payload)
      const passedQueueEnvelope = mockQueue.enqueue.mock.calls[0][2];
      expect(passedQueueEnvelope.payload.isOffloaded).toBe(true);
      expect(passedQueueEnvelope.payload.content).toBeUndefined();
    });
  });

  describe('IdentifyStage Transparent Hydration', () => {
    it('should transparently hydrate and parse offloaded Claim Check records', async () => {
      const largeContent = generateLargeBibtex(20);
      const compressed = zlib.gzipSync(Buffer.from(largeContent, 'utf-8'));
      const fileId = 'file-test-claim-check-1';
      storedFiles.set(fileId, {
        buffer: compressed,
        filename: 'ingest_bibtex.json.gz',
      });

      const offloadedPayload: any = {
        kind: 'RECORD',
        format: 'BIBTEX',
        isOffloaded: true,
        fileId,
        byteSize: compressed.length,
        uncompressedSize: largeContent.length,
      };

      const candidates = await identifyStage.execute(
        'run-test',
        offloadedPayload,
        'user-uuid-1',
      );

      expect(mockStoragePort.readOwnedFile).toHaveBeenCalledWith({ fileId });
      expect(candidates.length).toBe(20);
      expect(candidates[0].normalizedMetadata.title).toContain(
        'Scalable Distributed Computing in Scientific Architecture Paper 0',
      );
      expect(candidates[19].normalizedMetadata.doi).toBe(
        '10.1000/182.large.scale.19',
      );
    });

    it('should parse inline small records as normal without calling StoragePort', async () => {
      const inlinePayload: any = {
        kind: 'RECORD',
        format: 'BIBTEX',
        content: sampleBibtexSmall,
      };

      const candidates = await identifyStage.execute(
        'run-test',
        inlinePayload,
        'user-uuid-1',
      );

      expect(mockStoragePort.readOwnedFile).not.toHaveBeenCalled();
      expect(candidates.length).toBe(1);
      expect(candidates[0].normalizedMetadata.title).toBe(
        'Zur Elektrodynamik bewegter Korper',
      );
    });
  });
});
