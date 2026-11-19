import { Readable } from 'node:stream';
import type { Job, Queue } from 'bullmq';
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import {
  BlobService,
  BlobStatus,
  ContentHash,
  DEFAULT_STORAGE_QUOTA_BYTES,
  FilesController,
  FilesFacade,
  FilesLifecycleService,
  FilesMaintenanceProcessor,
  FileStreamService,
  FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
  FILES_JOB_RECLAIM_ORPHAN_BLOBS,
  IBlobRepository,
  IQuotaRepository,
  ISessionRepository,
  IStorageAdapter,
  MAX_PDF_THUMBNAIL_BYTES,
  PresignService,
  QuotaService,
  S3StorageAdapter,
  StorageBlob,
  StorageKey,
  StorageQuota,
  ThumbnailService,
  UploadSession,
  UploadSessionStatus,
} from '@/modules/files';

function createMockAdapter(): jest.Mocked<IStorageAdapter> {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    getStream: jest.fn(),
    stat: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    copy: jest.fn().mockResolvedValue(undefined),
    getPresignedUploadUrl: jest.fn().mockResolvedValue('https://signed/put'),
    getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://signed/get'),
    initiateMultipartUpload: jest
      .fn()
      .mockResolvedValue({ uploadId: 'mpu-upload-1' }),
    getPresignedPartUploadUrl: jest
      .fn()
      .mockResolvedValue('https://signed/part'),
    completeMultipartUpload: jest
      .fn()
      .mockResolvedValue({ eTag: 'completed-etag' }),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    listUploadedParts: jest.fn().mockResolvedValue([]),
    applyLifecycleRules: jest.fn().mockResolvedValue(undefined),
    getLifecycleRules: jest.fn().mockResolvedValue(null),
  };
}

function createMockBlobRepo(): jest.Mocked<IBlobRepository> {
  return {
    findById: jest.fn().mockResolvedValue(null),
    findByHash: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation(async (blob) => blob),
    delete: jest.fn().mockResolvedValue(undefined),
    findTombstonedBlobs: jest.fn().mockResolvedValue([]),
    incrementRefCount: jest.fn().mockResolvedValue(null),
    decrementRefCount: jest.fn().mockResolvedValue(null),
    claimBlobForPurge: jest.fn().mockResolvedValue(true),
    restoreClaimedBlob: jest.fn().mockResolvedValue(undefined),
  };
}

describe('FilesModule Self-Contained Lifecycle, Quota & RAM Guard', () => {
  describe('FilesLifecycleService', () => {
    const originalBootstrapEnv = process.env.FILES_BOOTSTRAP_LIFECYCLE;

    afterEach(() => {
      if (originalBootstrapEnv === undefined) {
        delete process.env.FILES_BOOTSTRAP_LIFECYCLE;
      } else {
        process.env.FILES_BOOTSTRAP_LIFECYCLE = originalBootstrapEnv;
      }
    });

    it('applies bucket lifecycle rules and registers repeatable BullMQ jobs on bootstrap', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const mockQueue = {
        on: jest.fn(),
        upsertJobScheduler: jest.fn().mockResolvedValue({}),
      };

      const lifecycle = new FilesLifecycleService(
        blobService,
        mockQueue as unknown as Queue,
      );

      await lifecycle.onApplicationBootstrap();

      expect(adapter.applyLifecycleRules).toHaveBeenCalledTimes(1);
      expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(mockQueue.upsertJobScheduler).toHaveBeenNthCalledWith(
        1,
        'files-repeat-multipart-cleanup',
        { pattern: '0 */6 * * *' },
        {
          name: FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
          opts: { removeOnComplete: 100, removeOnFail: 200 },
        },
      );
      expect(mockQueue.upsertJobScheduler).toHaveBeenNthCalledWith(
        2,
        'files-repeat-orphan-blob-gc',
        { pattern: '0 4 * * *' },
        {
          name: FILES_JOB_RECLAIM_ORPHAN_BLOBS,
          opts: { removeOnComplete: 100, removeOnFail: 200 },
        },
      );
    });

    it('skips bootstrap when FILES_BOOTSTRAP_LIFECYCLE=false', async () => {
      process.env.FILES_BOOTSTRAP_LIFECYCLE = 'false';
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const mockQueue = {
        on: jest.fn(),
        upsertJobScheduler: jest.fn().mockResolvedValue({}),
      };

      const lifecycle = new FilesLifecycleService(
        blobService,
        mockQueue as unknown as Queue,
      );

      await lifecycle.onApplicationBootstrap();

      expect(adapter.applyLifecycleRules).not.toHaveBeenCalled();
      expect(mockQueue.upsertJobScheduler).not.toHaveBeenCalled();
    });
  });

  describe('FilesMaintenanceProcessor', () => {
    it('dispatches cleanup-expired-sessions and reclaim-orphan-blobs cleanly', async () => {
      const mockBlobService = {
        reclaimOrphanBlobs: jest.fn().mockResolvedValue(4),
      } as unknown as BlobService;
      const mockPresignService = {
        cleanupExpiredSessions: jest.fn().mockResolvedValue(3),
      } as unknown as PresignService;

      const processor = new FilesMaintenanceProcessor(
        mockBlobService,
        mockPresignService,
      );

      const sessionResult = await processor.process({
        id: 'job-mpu-1',
        name: FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
        data: {},
      } as Job<unknown>);
      expect(mockPresignService.cleanupExpiredSessions).toHaveBeenCalledWith(
        100,
      );
      expect(sessionResult).toBe(3);

      const orphanResult = await processor.process({
        id: 'job-gc-1',
        name: FILES_JOB_RECLAIM_ORPHAN_BLOBS,
        data: {},
      } as Job<unknown>);
      expect(mockBlobService.reclaimOrphanBlobs).toHaveBeenCalledWith(100);
      expect(orphanResult).toBe(4);

      const unknownResult = await processor.process({
        id: 'job-unknown',
        name: 'unknown-maintenance-job',
        data: {},
      } as Job<unknown>);
      expect(unknownResult).toBeNull();
    });
  });

  describe('PresignService.cleanupExpiredSessions', () => {
    it('aborts expired multipart sessions in storage adapter and marks ABORTED in DB', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const quotaService = new QuotaService({
        findBySpaceId: jest.fn(),
        incrementUsage: jest.fn(),
        decrementUsage: jest.fn(),
      });

      const expiredSession = new UploadSession({
        id: 'session-expired-1',
        userId: 'user-1',
        s3UploadId: 'r2-upload-id-99',
        s3Key: 'uploads/staging/multipart/session-expired-1/payload.bin',
        filename: 'dataset.parquet',
        mimeType: 'application/octet-stream',
        totalSize: 25_000_000n,
        partSize: 5_242_880,
        totalParts: 5,
        expiresAt: new Date(Date.now() - 3600_000),
      });

      const sessionRepo: jest.Mocked<ISessionRepository> = {
        create: jest.fn(),
        findById: jest.fn(),
        update: jest.fn().mockImplementation(async (s) => s),
        findExpiredSessions: jest.fn().mockResolvedValue([expiredSession]),
      };

      const presignService = new PresignService(
        blobService,
        quotaService,
        sessionRepo,
      );

      const cleaned = await presignService.cleanupExpiredSessions(50);

      expect(cleaned).toBe(1);
      expect(adapter.abortMultipartUpload).toHaveBeenCalledWith(
        'uploads/staging/multipart/session-expired-1/payload.bin',
        'r2-upload-id-99',
      );
      expect(expiredSession.status).toBe(UploadSessionStatus.ABORTED);
      expect(sessionRepo.update).toHaveBeenCalledWith(expiredSession);
    });
  });

  describe('FilesController.getQuota', () => {
    it('returns personal & project quota usage metrics and 5 GB default fallback', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const projectUuid = '11111111-1111-4111-8111-111111111111';

      const quotaRepo: jest.Mocked<IQuotaRepository> = {
        findBySpaceId: jest.fn(async (spaceId) => {
          if (spaceId === projectUuid) {
            return new StorageQuota({
              id: 'q-proj',
              spaceId: projectUuid,
              usedBytes: 250n * 1024n * 1024n,
              maxBytes: 1000n * 1024n * 1024n,
            });
          }
          return null;
        }),
        incrementUsage: jest.fn(),
        decrementUsage: jest.fn(),
      };

      const quotaService = new QuotaService(quotaRepo);
      const presignService = new PresignService(blobService, quotaService, {
        create: jest.fn(),
        findById: jest.fn(),
        update: jest.fn(),
        findExpiredSessions: jest.fn(),
      });
      const streamService = new FileStreamService(blobService);
      const facade = new FilesFacade(
        blobService,
        quotaService,
        presignService,
        streamService,
      );
      const controller = new FilesController(facade, blobService);

      const personalRes = await controller.getQuota('user-1');
      expect(personalRes).toEqual({
        usedBytes: 0,
        maxBytes: Number(DEFAULT_STORAGE_QUOTA_BYTES),
        remainingBytes: Number(DEFAULT_STORAGE_QUOTA_BYTES),
        usagePercent: 0,
        scope: 'personal',
        spaceId: 'user-1',
      });

      const projectRes = await controller.getQuota('user-1', projectUuid);
      expect(projectRes).toEqual({
        usedBytes: 250 * 1024 * 1024,
        maxBytes: 1000 * 1024 * 1024,
        remainingBytes: 750 * 1024 * 1024,
        usagePercent: 25,
        scope: 'project',
        spaceId: projectUuid,
      });
    });
  });

  describe('FilesFacade.ensurePdfThumbnail RAM Guard', () => {
    it('skips streaming and returns null for PDFs exceeding 25 MB, while rendering smaller PDFs', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hashSmall = ContentHash.fromBuffer(Buffer.from('small-pdf'));
      const hashBig = ContentHash.fromBuffer(Buffer.from('big-pdf'));

      const smallBlob = new StorageBlob({
        id: 'blob-small-pdf',
        contentHash: hashSmall,
        sizeBytes: 1024n,
        s3Key: StorageKey.forBlob(hashSmall.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
      });
      const bigBlob = new StorageBlob({
        id: 'blob-huge-pdf',
        contentHash: hashBig,
        sizeBytes: MAX_PDF_THUMBNAIL_BYTES + 1n,
        s3Key: StorageKey.forBlob(hashBig.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
      });

      blobRepo.findById.mockImplementation(async (id) => {
        if (id === smallBlob.id) return smallBlob;
        if (id === bigBlob.id) return bigBlob;
        return null;
      });

      const pdfPayload = Buffer.from('%PDF-1.7 sample');
      adapter.getStream.mockResolvedValue({
        stream: Readable.from([pdfPayload]),
        contentLength: pdfPayload.length,
      });

      const renderedWebp = Buffer.from('webp-thumb-bytes');
      const mockThumbnailService = {
        generateThumbnail: jest.fn().mockResolvedValue(renderedWebp),
      } as unknown as ThumbnailService;

      const blobService = new BlobService(adapter, blobRepo);
      const quotaService = new QuotaService({
        findBySpaceId: jest.fn(),
        incrementUsage: jest.fn(),
        decrementUsage: jest.fn(),
      });
      const presignService = new PresignService(blobService, quotaService, {
        create: jest.fn(),
        findById: jest.fn(),
        update: jest.fn(),
        findExpiredSessions: jest.fn(),
      });
      const streamService = new FileStreamService(blobService);
      const facade = new FilesFacade(
        blobService,
        quotaService,
        presignService,
        streamService,
        mockThumbnailService,
      );

      const skipped = await facade.ensurePdfThumbnail({ fileId: bigBlob.id });
      expect(skipped).toBeNull();
      expect(adapter.getStream).not.toHaveBeenCalled();
      expect(mockThumbnailService.generateThumbnail).not.toHaveBeenCalled();

      const generated = await facade.ensurePdfThumbnail({
        fileId: smallBlob.id,
      });
      expect(generated).toEqual(renderedWebp);
      expect(mockThumbnailService.generateThumbnail).toHaveBeenCalledWith(
        pdfPayload,
      );
      expect(adapter.put).toHaveBeenCalledWith(
        `thumbnails/${smallBlob.id}.webp`,
        renderedWebp,
        { mimeType: 'image/webp', size: renderedWebp.length },
      );
    });
  });

  describe('S3StorageAdapter default Cloudflare R2 lifecycle rules', () => {
    it('omits AWS-only GLACIER and DEEP_ARCHIVE transitions from default lifecycle configuration', async () => {
      const s3Adapter = new S3StorageAdapter({
        endpoint: 'https://test-account.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'flux',
        credentials: {
          accessKeyId: 'r2-access',
          secretAccessKey: 'r2-secret',
        },
      });
      const mockSend = jest.fn().mockResolvedValue({});
      (s3Adapter as unknown as { client: { send: jest.Mock } }).client = {
        send: mockSend,
      };

      await s3Adapter.applyLifecycleRules();

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0]?.[0] as unknown;
      expect(command).toBeInstanceOf(PutBucketLifecycleConfigurationCommand);

      const rules =
        (command as PutBucketLifecycleConfigurationCommand).input
          .LifecycleConfiguration?.Rules ?? [];
      expect(rules.map((r) => r.ID)).toEqual([
        'cleanup-staging-uploads',
        'cleanup-temp-uploads',
        'abort-incomplete-multipart',
        'archive-cold-storage',
        'expire-old-backups',
      ]);

      const allTransitions = rules.flatMap((r) => r.Transitions ?? []);
      expect(
        allTransitions.some(
          (t) =>
            t.StorageClass === 'GLACIER' || t.StorageClass === 'DEEP_ARCHIVE',
        ),
      ).toBe(false);
      expect(allTransitions).toEqual([
        { Days: 90, StorageClass: 'STANDARD_IA' },
      ]);
    });
  });
});
