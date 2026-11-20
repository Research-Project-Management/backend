import { Readable } from 'node:stream';
import type { Job, Queue } from 'bullmq';
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import {
  BlobStatus,
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_PDF_THUMBNAIL_BYTES,
  StorageBlobRecord,
  StorageQuotaRecord,
  UploadSessionRecord,
  UploadSessionStatus,
} from '@/modules/files';
import {
  FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
  FILES_JOB_RECLAIM_ORPHAN_BLOBS,
  FILES_JOB_RECONCILE_QUOTAS,
  FILES_JOB_RECOVER_STALE_FINALIZING,
  FILES_JOB_SWEEP_STAGING_BLOBS,
} from '@/modules/files/files.constant';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage-vo';
import { FilesFacade } from '@/modules/files/files.facade';
import { FilesController } from '@/modules/files/controllers/files.controller';
import { S3StorageAdapter } from '@/modules/files/adapters/s3.adapter';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import { ThumbnailService } from '@/modules/files/services/thumbnail.service';
import { FilesMaintenanceProcessor } from '@/modules/files/processors/files-maintenance.processor';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';

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

function makeBlobRecord(
  overrides: Partial<StorageBlobRecord> & {
    id: string;
    contentHashHex: string;
  },
): StorageBlobRecord {
  return {
    hashAlgorithm: 'SHA256',
    sizeBytes: 128n,
    mimeType: 'application/octet-stream',
    checksumVerified: true,
    s3Key: StorageKey.forBlob(overrides.contentHashHex).value(),
    s3Bucket: 'flux',
    storageClass: 'STANDARD',
    refCount: 1,
    status: BlobStatus.READY,
    createdAt: new Date(),
    tombstoneAt: null,
    claimedAt: null,
    ...overrides,
  };
}

function createMockBlobRepo(): jest.Mocked<BlobRepository> {
  return {
    findById: jest.fn().mockResolvedValue(null),
    findByHash: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation(async (input) =>
      makeBlobRecord({
        id: input.id,
        contentHashHex: input.contentHashHex,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
        checksumVerified: input.checksumVerified,
        s3Key: input.s3Key,
        s3Bucket: input.s3Bucket,
        status: input.status ?? BlobStatus.READY,
        refCount: input.refCount ?? 1,
      }),
    ),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockResolvedValue(undefined),
    incrementRefCount: jest.fn().mockResolvedValue(null),
    decrementRefCount: jest.fn().mockResolvedValue(null),
    reclaimStuckClaims: jest.fn().mockResolvedValue(0),
    claimOrphanBlobsBatch: jest.fn().mockResolvedValue([]),
    restoreClaimedBlob: jest.fn().mockResolvedValue(undefined),
    hasSpaceAccessToBlob: jest.fn().mockResolvedValue(true),
    attachRef: jest.fn(),
    detachRef: jest.fn(),
    existsInSpace: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<BlobRepository>;
}

function createMockQuotaRepo(
  findImpl: (
    spaceId?: string | null,
  ) => Promise<StorageQuotaRecord | null> = async () => null,
): jest.Mocked<QuotaRepository> {
  return {
    findBySpaceId: jest.fn(findImpl),
    assertAvailable: jest.fn().mockResolvedValue(undefined),
    incrementUsage: jest.fn().mockResolvedValue(0n),
    decrementUsage: jest.fn().mockResolvedValue(0n),
    reconcileSpaceQuotas: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<QuotaRepository>;
}

function createMockSessionRepo(): jest.Mocked<SessionRepository> {
  return {
    findById: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation(async (s) => s),
    markStatus: jest.fn().mockImplementation(async (id, status) => ({
      id,
      status,
    })),
    markUploadingIfInitialized: jest.fn().mockResolvedValue(true),
    findExpiredSessions: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<SessionRepository>;
}

describe('FilesModule Self-Contained Lifecycle, Quota & RAM Guard', () => {
  describe('FilesMaintenanceProcessor (Lifecycle & Job Dispatch)', () => {
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
      const quotaRepo = createMockQuotaRepo();
      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
      );
      const mockQueue = {
        on: jest.fn(),
        upsertJobScheduler: jest.fn().mockResolvedValue({}),
      };

      const processor = new FilesMaintenanceProcessor(
        adapter,
        blobService,
        uploadService,
        quotaRepo,
        mockQueue as unknown as Queue,
      );

      await processor.onApplicationBootstrap();

      expect(adapter.applyLifecycleRules).toHaveBeenCalledTimes(1);
      expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(5);
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
        { pattern: '0 */2 * * *' },
        {
          name: FILES_JOB_RECLAIM_ORPHAN_BLOBS,
          opts: { removeOnComplete: 100, removeOnFail: 200 },
        },
      );
      expect(mockQueue.upsertJobScheduler).toHaveBeenNthCalledWith(
        3,
        'files-repeat-quota-reconcile',
        { pattern: '30 3 * * *' },
        {
          name: FILES_JOB_RECONCILE_QUOTAS,
          opts: { removeOnComplete: 100, removeOnFail: 200 },
        },
      );
      expect(mockQueue.upsertJobScheduler).toHaveBeenNthCalledWith(
        4,
        'files-repeat-stale-finalizing-recovery',
        { pattern: '*/5 * * * *' },
        {
          name: FILES_JOB_RECOVER_STALE_FINALIZING,
          opts: { removeOnComplete: 100, removeOnFail: 200 },
        },
      );
      expect(mockQueue.upsertJobScheduler).toHaveBeenNthCalledWith(
        5,
        'files-repeat-sweep-staging-blobs',
        { pattern: '*/10 * * * *' },
        {
          name: FILES_JOB_SWEEP_STAGING_BLOBS,
          opts: { removeOnComplete: 100, removeOnFail: 200 },
        },
      );
    });

    it('skips bootstrap when FILES_BOOTSTRAP_LIFECYCLE=false', async () => {
      process.env.FILES_BOOTSTRAP_LIFECYCLE = 'false';
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const quotaRepo = createMockQuotaRepo();
      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
      );
      const mockQueue = {
        on: jest.fn(),
        upsertJobScheduler: jest.fn().mockResolvedValue({}),
      };

      const processor = new FilesMaintenanceProcessor(
        adapter,
        blobService,
        uploadService,
        quotaRepo,
        mockQueue as unknown as Queue,
      );

      await processor.onApplicationBootstrap();

      expect(adapter.applyLifecycleRules).not.toHaveBeenCalled();
      expect(mockQueue.upsertJobScheduler).not.toHaveBeenCalled();
    });

    it('dispatches cleanup-expired-sessions, reclaim-orphan-blobs batches, and quota reconciliation', async () => {
      const adapter = createMockAdapter();
      const mockBlobService = {
        reclaimOrphanBlobs: jest.fn().mockResolvedValue(4),
      } as unknown as BlobService;
      const mockUploadService = {
        cleanupExpiredSessions: jest.fn().mockResolvedValue(3),
        recoverStaleFinalizingSessions: jest.fn().mockResolvedValue(2),
        sweepUnpromotedStagingBlobs: jest.fn().mockResolvedValue(5),
      } as unknown as FilesUploadService;
      const mockQuotaRepo = {
        reconcileSpaceQuotas: jest.fn().mockResolvedValue(2),
      } as unknown as QuotaRepository;

      const processor = new FilesMaintenanceProcessor(
        adapter,
        mockBlobService,
        mockUploadService,
        mockQuotaRepo,
      );

      const sessionResult = await processor.process({
        id: 'job-mpu-1',
        name: FILES_JOB_CLEANUP_EXPIRED_SESSIONS,
        data: {},
      } as Job<unknown>);
      expect(mockUploadService.cleanupExpiredSessions).toHaveBeenCalledWith(
        100,
      );
      expect(sessionResult).toBe(3);

      const orphanResult = await processor.process({
        id: 'job-gc-1',
        name: FILES_JOB_RECLAIM_ORPHAN_BLOBS,
        data: {},
      } as Job<unknown>);
      expect(mockBlobService.reclaimOrphanBlobs).toHaveBeenCalledWith(200, {
        maxBatches: 5,
        timeBudgetMs: 45_000,
      });
      expect(orphanResult).toBe(4);

      const quotaResult = await processor.process({
        id: 'job-quota-1',
        name: FILES_JOB_RECONCILE_QUOTAS,
        data: {},
      } as Job<unknown>);
      expect(mockQuotaRepo.reconcileSpaceQuotas).toHaveBeenCalledWith(200);
      expect(quotaResult).toBe(2);

      const staleResult = await processor.process({
        id: 'job-stale-1',
        name: FILES_JOB_RECOVER_STALE_FINALIZING,
        data: {},
      } as Job<unknown>);
      expect(
        mockUploadService.recoverStaleFinalizingSessions,
      ).toHaveBeenCalledWith(100);
      expect(staleResult).toBe(2);

      const sweepResult = await processor.process({
        id: 'job-sweep-1',
        name: FILES_JOB_SWEEP_STAGING_BLOBS,
        data: {},
      } as Job<unknown>);
      expect(
        mockUploadService.sweepUnpromotedStagingBlobs,
      ).toHaveBeenCalledWith(100);
      expect(sweepResult).toBe(5);

      const unknownResult = await processor.process({
        id: 'job-unknown',
        name: 'unknown-maintenance-job',
        data: {},
      } as Job<unknown>);
      expect(unknownResult).toBeNull();
    });
  });

  describe('FilesUploadService.cleanupExpiredSessions', () => {
    it('aborts expired multipart sessions in storage adapter and marks ABORTED in DB', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const quotaRepo = createMockQuotaRepo();

      const expiredSession: UploadSessionRecord = {
        id: 'session-expired-1',
        spaceId: 'user-1',
        userId: 'user-1',
        s3UploadId: 'r2-upload-id-99',
        s3Key: 'uploads/staging/multipart/session-expired-1/payload.bin',
        filename: 'dataset.parquet',
        mimeType: 'application/octet-stream',
        totalSize: 25_000_000n,
        partSize: 5_242_880,
        totalParts: 5,
        expectedHashHex: null,
        parentId: null,
        status: UploadSessionStatus.INITIALIZED,
        expiresAt: new Date(Date.now() - 3600_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const sessionRepo = createMockSessionRepo();
      sessionRepo.findExpiredSessions.mockResolvedValue([expiredSession]);

      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        sessionRepo,
      );

      const cleaned = await uploadService.cleanupExpiredSessions(50);

      expect(cleaned).toBe(1);
      expect(adapter.abortMultipartUpload).toHaveBeenCalledWith(
        'uploads/staging/multipart/session-expired-1/payload.bin',
        'r2-upload-id-99',
      );
      expect(sessionRepo.markStatus).toHaveBeenCalledWith(
        'session-expired-1',
        UploadSessionStatus.ABORTED,
      );
    });
  });

  describe('FilesController.getQuota', () => {
    it('returns personal & project quota usage metrics and 5 GB default fallback', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const projectUuid = '11111111-1111-4111-8111-111111111111';

      const quotaRepo = createMockQuotaRepo(async (spaceId) => {
        if (spaceId === projectUuid) {
          return {
            spaceId: projectUuid,
            usedBytes: 250n * 1024n * 1024n,
            maxBytes: 1000n * 1024n * 1024n,
            updatedAt: new Date(),
          };
        }
        return null;
      });

      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
      );
      const facade = new FilesFacade(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        uploadService,
      );
      const controller = new FilesController(facade);

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

  describe('FilesFacade & ThumbnailService.ensurePdfThumbnail RAM Guard', () => {
    it('skips streaming and returns null for PDFs exceeding 25 MB, while rendering smaller PDFs', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hashSmall = ContentHash.fromBuffer(
        Buffer.from('small-pdf'),
      ).toHex();
      const hashBig = ContentHash.fromBuffer(Buffer.from('big-pdf')).toHex();

      const smallBlob = makeBlobRecord({
        id: 'blob-small-pdf',
        contentHashHex: hashSmall,
        sizeBytes: 1024n,
      });
      const bigBlob = makeBlobRecord({
        id: 'blob-huge-pdf',
        contentHashHex: hashBig,
        sizeBytes: MAX_PDF_THUMBNAIL_BYTES + 1n,
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

      const blobService = new BlobService(adapter, blobRepo);
      const thumbnailService = new ThumbnailService(
        adapter,
        blobRepo,
        blobService,
      );
      const renderedWebp = Buffer.from('webp-thumb-bytes');
      const genSpy = jest
        .spyOn(thumbnailService, 'generateThumbnail')
        .mockResolvedValue(renderedWebp);

      const quotaRepo = createMockQuotaRepo();
      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
      );
      const facade = new FilesFacade(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        uploadService,
        thumbnailService,
      );

      const skipped = await facade.ensurePdfThumbnail({ fileId: bigBlob.id });
      expect(skipped).toBeNull();
      expect(adapter.getStream).not.toHaveBeenCalled();
      expect(genSpy).not.toHaveBeenCalled();

      const generated = await facade.ensurePdfThumbnail({
        fileId: smallBlob.id,
      });
      expect(generated).toEqual(renderedWebp);
      expect(genSpy).toHaveBeenCalledWith(pdfPayload);
      expect(adapter.put).toHaveBeenCalledWith(
        StorageKey.forDerivative(hashSmall, 'thumb').value(),
        renderedWebp,
        { mimeType: 'image/webp', size: renderedWebp.length },
      );
    });

    it('coalesces concurrent ensurePdfThumbnail requests for the same blob via singleflight lock', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hashHex = ContentHash.fromBuffer(
        Buffer.from('concurrent-pdf'),
      ).toHex();
      const blob = makeBlobRecord({
        id: 'blob-singleflight',
        contentHashHex: hashHex,
        sizeBytes: 1024n,
      });
      blobRepo.findById.mockResolvedValue(blob);

      const pdfPayload = Buffer.from('%PDF-1.7 concurrent');
      adapter.getStream.mockImplementation(async () => ({
        stream: Readable.from([pdfPayload]),
        contentLength: pdfPayload.length,
      }));

      const blobService = new BlobService(adapter, blobRepo);
      const thumbService = new ThumbnailService(adapter, blobRepo, blobService);
      const renderedWebp = Buffer.from('singleflight-webp');
      const genSpy = jest
        .spyOn(thumbService, 'generateThumbnail')
        .mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 15));
          return renderedWebp;
        });

      const quotaRepo = createMockQuotaRepo();
      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
      );
      const facade = new FilesFacade(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        uploadService,
        thumbService,
      );

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          facade.ensurePdfThumbnail({ fileId: blob.id }),
        ),
      );

      expect(results).toEqual(Array.from({ length: 5 }, () => renderedWebp));
      expect(genSpy).toHaveBeenCalledTimes(1);
      expect(adapter.put).toHaveBeenCalledTimes(1);
    });
  });

  describe('BlobService batch SKIP LOCKED GC & derivative purge', () => {
    it('reclaims stuck leases, drains batches, and deletes both blobs and derivative thumbnails', async () => {
      const adapter = createMockAdapter();
      const hash1 = ContentHash.fromBuffer(Buffer.from('gc-batch-1')).toHex();
      const hash2 = ContentHash.fromBuffer(Buffer.from('gc-batch-2')).toHex();
      const blob1 = makeBlobRecord({
        id: 'gc-1',
        contentHashHex: hash1,
        sizeBytes: 100n,
        status: BlobStatus.DELETED,
        refCount: 0,
      });
      const blob2 = makeBlobRecord({
        id: 'gc-2',
        contentHashHex: hash2,
        sizeBytes: 200n,
        status: BlobStatus.DELETED,
        refCount: 0,
      });

      const blobRepo = createMockBlobRepo();
      blobRepo.reclaimStuckClaims.mockResolvedValue(1);
      blobRepo.claimOrphanBlobsBatch
        .mockResolvedValueOnce([blob1, blob2])
        .mockResolvedValueOnce([]);

      const blobService = new BlobService(adapter, blobRepo);
      const deleted = await blobService.reclaimOrphanBlobs(2, {
        maxBatches: 3,
      });

      expect(deleted).toBe(2);
      expect(blobRepo.reclaimStuckClaims).toHaveBeenCalledTimes(1);
      expect(blobRepo.claimOrphanBlobsBatch).toHaveBeenCalledTimes(2);
      expect(adapter.deleteMany).toHaveBeenCalledWith(
        expect.arrayContaining([
          blob1.s3Key,
          StorageKey.forDerivative(hash1, 'thumb').value(),
          'thumbnails/gc-1.webp',
          blob2.s3Key,
          StorageKey.forDerivative(hash2, 'thumb').value(),
          'thumbnails/gc-2.webp',
        ]),
      );
      expect(blobRepo.deleteMany).toHaveBeenCalledWith(['gc-1', 'gc-2']);
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
      const stagingRule = rules.find((r) => r.ID === 'cleanup-staging-uploads');
      expect(stagingRule?.Expiration?.Days).toBe(3);
      expect(
        stagingRule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation,
      ).toBe(2);

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
