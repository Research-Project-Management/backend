import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'node:stream';
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromPartial } from '@total-typescript/shoehorn';
import type { Job, Queue } from 'bullmq';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  type DistributedLockService,
  type PrismaService,
  RateLimitConfigService,
  type RedisCacheService,
  USER_RATE_LIMIT_KEY,
  UserRateLimitGuard,
  type UserRateLimitRule,
} from '@/core';
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  FILE_JOBS,
  MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER,
  PRESIGN_COMPLETE_IDEM_TTL_SECONDS,
  STAGING_DELETE_DELAY_MS,
} from '@/modules/files/files.constant';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import { S3StorageAdapter } from '@/modules/files/adapters/s3.adapter';
import { FilesController } from '@/modules/files/controllers/files.controller';
import { FilesFacade } from '@/modules/files/files.facade';
import { CasProcessor } from '@/modules/files/processors/cas.processor';
import { CleanupProcessor } from '@/modules/files/processors/cleanup.processor';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { FileAccessService } from '@/modules/files/services/access.service';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';
import {
  BlobStatus,
  type BlobRefRecord,
  type StorageBlobRecord,
  type StorageQuotaRecord,
} from '@/modules/files/types/files.type';

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

function createStorageMocks(quota: StorageQuotaRecord | null = null) {
  const blobs = new Map<string, StorageBlobRecord>();

  const adapter: jest.Mocked<IStorageAdapter> = {
    put: jest.fn().mockResolvedValue(undefined),
    getStream: jest.fn(),
    stat: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(true),
    copy: jest.fn().mockResolvedValue(undefined),
    getPresignedUploadUrl: jest.fn().mockResolvedValue('https://signed/put'),
    getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://signed/get'),
    initiateMultipartUpload: jest.fn().mockResolvedValue({ uploadId: 'mpu-1' }),
    getPresignedPartUploadUrl: jest.fn().mockResolvedValue('https://signed/part'),
    completeMultipartUpload: jest.fn().mockResolvedValue({ eTag: 'etag-1' }),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    listUploadedParts: jest.fn().mockResolvedValue([]),
    applyLifecycleRules: jest.fn().mockResolvedValue(undefined),
    getLifecycleRules: jest.fn().mockResolvedValue(null),
  };

  const blobRepo = fromPartial<jest.Mocked<BlobRepository>>({
    findById: jest.fn(async (id: string) => blobs.get(id) ?? null),
    findByHash: jest.fn(async (hex: string) => {
      for (const b of blobs.values()) {
        if (b.contentHashHex === hex) return b;
      }
      return null;
    }),
    findByStorageKey: jest.fn(async (key: string) => {
      for (const b of blobs.values()) {
        if (b.s3Key === key) return b;
      }
      return null;
    }),
    existsByStorageKey: jest.fn(async (key: string) => {
      for (const b of blobs.values()) {
        if (b.s3Key === key) return true;
      }
      return false;
    }),
    create: jest.fn(async (input) => {
      const rec = makeBlobRecord({
        id: input.id,
        contentHashHex: input.contentHashHex,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
        checksumVerified: input.checksumVerified,
        s3Key: input.s3Key,
        s3Bucket: input.s3Bucket,
        status: input.status ?? BlobStatus.READY,
        refCount: input.refCount ?? 1,
      });
      blobs.set(rec.id, rec);
      return rec;
    }),
    delete: jest.fn(async (id: string) => {
      blobs.delete(id);
    }),
    deleteMany: jest.fn().mockResolvedValue(undefined),
    incrementRefCount: jest.fn(async (id: string) => {
      const b = blobs.get(id);
      if (!b) return null;
      const updated = { ...b, refCount: b.refCount + 1 };
      blobs.set(id, updated);
      return updated;
    }),
    decrementRefCount: jest.fn().mockResolvedValue(null),
    reclaimStuckClaims: jest.fn().mockResolvedValue(0),
    claimOrphanBlobsBatch: jest.fn().mockResolvedValue([]),
    restoreClaimedBlob: jest.fn().mockResolvedValue(undefined),
    hasSpaceAccessToBlob: jest.fn().mockResolvedValue(true),
    hasUserAccessToSpace: jest.fn().mockResolvedValue(true),
    hasUserAccessToBlob: jest.fn().mockResolvedValue(true),
    attachRef: jest.fn(),
    detachRef: jest.fn(),
    existsInSpace: jest.fn().mockResolvedValue(false),
    promoteStorageLocation: jest.fn(async (input) => {
      const existing = blobs.get(input.blobId);
      if (!existing || existing.s3Key !== input.expectedCurrentKey) return false;
      blobs.set(input.blobId, {
        ...existing,
        s3Key: input.nextStorageKey,
        contentHashHex: input.nextContentHashHex ?? existing.contentHashHex,
        checksumVerified: input.checksumVerified,
      });
      return true;
    }),
  });

  const quotaRepo = fromPartial<jest.Mocked<QuotaRepository>>({
    findBySpaceId: jest.fn().mockResolvedValue(quota),
    assertAvailable: jest.fn(async (_spaceId, requiredBytes: bigint) => {
      const maxBytes = quota ? quota.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
      const usedBytes = quota ? quota.usedBytes : 0n;
      if (usedBytes + requiredBytes > maxBytes) {
        throw new BadRequestException('Storage quota exceeded');
      }
    }),
    incrementUsage: jest.fn().mockResolvedValue(0n),
    decrementUsage: jest.fn().mockResolvedValue(0n),
    reconcileSpaceQuotas: jest.fn().mockResolvedValue(0),
  });

  const sessionRepo = fromPartial<jest.Mocked<SessionRepository>>({
    findById: jest.fn().mockResolvedValue(null),
    create: jest.fn(async (s) => fromPartial(s)),
    markStatus: jest.fn(async (id, status) => fromPartial({ id, status })),
    markUploadingIfInitialized: jest.fn().mockResolvedValue(true),
    findExpiredSessions: jest.fn().mockResolvedValue([]),
  });

  const blobService = new BlobService(adapter, blobRepo);
  const uploadService = new FilesUploadService(
    adapter,
    blobService,
    blobRepo,
    quotaRepo,
    sessionRepo,
  );
  const accessService = new FileAccessService(blobRepo);
  const facade = new FilesFacade(
    adapter,
    blobService,
    blobRepo,
    quotaRepo,
    uploadService,
    undefined,
    accessService,
  );

  return {
    blobs,
    adapter,
    blobRepo,
    quotaRepo,
    sessionRepo,
    blobService,
    uploadService,
    accessService,
    facade,
  };
}

describe('Files Storage CAS, Lifecycle, Quota & Delivery Security Suite', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('CAS Promotion, Fast-Finalize & Collision Safety', () => {
    it('promotes verified staging uploads to canonical CAS, isolates >100MB unhashed blobs to blobs/raw/, and rejects CAS poisoning', async () => {
      const { adapter, blobRepo, blobService } = createStorageMocks();

      const payload = Buffer.from('%PDF-1.7 canonical promotion payload');
      const shaHex = crypto.createHash('sha256').update(payload).digest('hex');
      const stagingKey = 'uploads/staging/u1/file.pdf';
      const canonicalKey = `blobs/${shaHex.slice(0, 2)}/${shaHex.slice(2, 4)}/${shaHex}`;

      const promoted = await blobService.registerUploadedObject({
        storageKey: stagingKey,
        sizeBytes: BigInt(payload.length),
        contentHashHex: shaHex,
      });
      expect(promoted.isDeduplicated).toBe(false);
      expect(promoted.blob.s3Key).toBe(canonicalKey);
      expect(adapter.copy).toHaveBeenCalledWith(stagingKey, canonicalKey);
      expect(adapter.delete).toHaveBeenCalledWith(stagingKey);

      const largeUnhashed = await blobService.registerUploadedObject({
        storageKey: 'uploads/staging/multipart/sess-150mb/payload.bin',
        sizeBytes: 150n * 1024n * 1024n,
        contentHashHex: 'a'.repeat(64),
        mimeType: 'application/zip',
        checksumVerified: false,
      });
      expect(largeUnhashed.blob.checksumVerified).toBe(false);
      expect(largeUnhashed.blob.s3Key).toMatch(/^blobs\/raw\/[a-z0-9]{2}\//);

      // CAS poisoning defense: stream SHA-256 mismatch
      const actualBytes = Buffer.from('%PDF-1.7 actual payload bytes');
      adapter.getStream.mockResolvedValue({
        stream: Readable.from([actualBytes]),
        contentLength: actualBytes.length,
      });
      const poisonKey = 'uploads/staging/attacker/poison.pdf';
      blobRepo.create.mockClear();

      await expect(
        blobService.registerUploadedObject({
          storageKey: poisonKey,
          sizeBytes: BigInt(actualBytes.length),
          contentHashHex: 'f'.repeat(64),
          mimeType: 'application/pdf',
        }),
      ).rejects.toThrow('Content hash mismatch');
      expect(adapter.delete).toHaveBeenCalledWith(poisonKey);
      expect(blobRepo.create).not.toHaveBeenCalled();
    });

    it('isolates post-facto P2002 hash collisions into blobs/raw without deleting winner CAS key and guards delayed delete', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-cas-col-'));
      try {
        const localAdapter = new LocalStorageAdapter(tempDir);
        const { blobs, blobRepo } = createStorageMocks();
        const enqueuedJobs: Array<{
          name: string;
          data: unknown;
          opts?: Record<string, unknown>;
        }> = [];
        const finalizeCasQueue = fromPartial<Queue>({
          add: jest.fn(async (name: string, data: unknown, opts?: Record<string, unknown>) => {
            enqueuedJobs.push({ name, data, opts });
            return fromPartial<Job>({ id: `${name}-${enqueuedJobs.length}` });
          }),
        });

        const blobService = new BlobService(localAdapter, blobRepo);
        const casProcessor = new CasProcessor(
          localAdapter,
          blobService,
          blobRepo,
          finalizeCasQueue,
        );

        const payload = Buffer.from('%PDF-1.7\nidentical-concurrent-upload');
        const shaHex = ContentHash.fromBuffer(payload).toHex();
        const winnerCanonicalKey = StorageKey.forBlob(shaHex).value();

        const key1 = 'uploads/staging/u1/copy1.pdf';
        const key2 = 'uploads/staging/u2/copy2.pdf';
        await localAdapter.put(key1, payload);
        await localAdapter.put(key2, payload);

        const fast1 = await blobService.registerStagingObjectFast({
          storageKey: key1,
          sizeBytes: BigInt(payload.length),
          mimeType: 'application/pdf',
          checksumVerified: false,
        });
        expect(fast1.needsAsyncPromotion).toBe(true);

        const fast2 = await blobService.registerStagingObjectFast({
          storageKey: key2,
          sizeBytes: BigInt(payload.length),
          mimeType: 'application/pdf',
          checksumVerified: false,
        });

        await casProcessor.process(
          fromPartial<Job>({
            id: 'promote-1',
            name: FILE_JOBS.PROMOTE_CAS,
            data: { blobId: fast1.blob.id, stagingKey: key1 },
          }),
        );
        expect(blobs.get(fast1.blob.id)?.s3Key).toBe(winnerCanonicalKey);

        // Simulate P2002 race on blob 2
        blobRepo.findByHash.mockResolvedValueOnce(null);
        const originalPromote = blobRepo.promoteStorageLocation;
        blobRepo.promoteStorageLocation = jest
          .fn()
          .mockRejectedValueOnce({ code: 'P2002' })
          .mockImplementationOnce(originalPromote);

        const collisionRes = (await casProcessor.process(
          fromPartial<Job>({
            id: 'promote-2',
            name: FILE_JOBS.PROMOTE_CAS,
            data: { blobId: fast2.blob.id, stagingKey: key2 },
          }),
        )) as { promoted: boolean; isolated: boolean; finalKey?: string };

        const expectedIsolatedKey = StorageKey.forUnhashedBlob(
          fast2.blob.id,
        ).value();
        expect(collisionRes).toMatchObject({
          promoted: true,
          isolated: true,
          finalKey: expectedIsolatedKey,
        });
        expect(await localAdapter.exists(winnerCanonicalKey)).toBe(true);
        expect(await localAdapter.exists(expectedIsolatedKey)).toBe(true);

        const delJobs = enqueuedJobs.filter(
          (j) => j.name === FILE_JOBS.DELETE_STAGING,
        );
        expect(delJobs[1]?.opts?.delay).toBe(STAGING_DELETE_DELAY_MS);

        // Delayed delete refuses while a DB blob still references staging key
        const unpromotedKey = 'uploads/staging/u3/still-referenced.pdf';
        await localAdapter.put(unpromotedKey, payload);
        await blobService.registerStagingObjectFast({
          storageKey: unpromotedKey,
          sizeBytes: BigInt(payload.length),
          checksumVerified: false,
        });

        await expect(
          casProcessor.process(
            fromPartial<Job>({
              id: 'del-guard-1',
              name: FILE_JOBS.DELETE_STAGING,
              data: { storageKey: unpromotedKey },
            }),
          ),
        ).resolves.toBe(false);
        expect(await localAdapter.exists(unpromotedKey)).toBe(true);

        await expect(
          casProcessor.process(
            fromPartial<Job>({
              id: 'del-ok-2',
              name: FILE_JOBS.DELETE_STAGING,
              data: { storageKey: key2 },
            }),
          ),
        ).resolves.toBe(true);
        expect(await localAdapter.exists(key2)).toBe(false);
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Orphan GC, S3 R2 Lifecycle & Maintenance Dispatch', () => {
    const originalBootstrapEnv = process.env.FILES_BOOTSTRAP_LIFECYCLE;

    afterEach(() => {
      if (originalBootstrapEnv === undefined) {
        delete process.env.FILES_BOOTSTRAP_LIFECYCLE;
      } else {
        process.env.FILES_BOOTSTRAP_LIFECYCLE = originalBootstrapEnv;
      }
    });

    it('purges orphan blobs + derivative thumbnails in batches and restores claimed lease if physical delete fails', async () => {
      const { adapter, blobRepo, blobService } = createStorageMocks();
      const hash1 = ContentHash.fromBuffer(Buffer.from('gc-batch-1')).toHex();
      const hash2 = ContentHash.fromBuffer(Buffer.from('gc-batch-2')).toHex();
      const blob1 = makeBlobRecord({
        id: 'gc-1',
        contentHashHex: hash1,
        status: BlobStatus.DELETED,
        refCount: 0,
      });
      const blob2 = makeBlobRecord({
        id: 'gc-2',
        contentHashHex: hash2,
        status: BlobStatus.DELETED,
        refCount: 0,
      });

      blobRepo.reclaimStuckClaims.mockResolvedValueOnce(1);
      blobRepo.claimOrphanBlobsBatch
        .mockResolvedValueOnce([blob1, blob2])
        .mockResolvedValueOnce([]);

      expect(
        await blobService.reclaimOrphanBlobs(2, { maxBatches: 3 }),
      ).toBe(2);
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

      // Fallback single-blob error restores claim without deleting DB row
      const errBlob = makeBlobRecord({
        id: 'blob-err-1',
        contentHashHex: ContentHash.fromBuffer(Buffer.from('err')).toHex(),
        status: BlobStatus.DELETED,
        refCount: 0,
      });
      adapter.deleteMany.mockRejectedValueOnce(new Error('Batch failed'));
      adapter.delete.mockRejectedValueOnce(new Error('S3 timeout'));
      blobRepo.claimOrphanBlobsBatch.mockResolvedValueOnce([errBlob]);
      blobRepo.delete.mockClear();

      expect(await blobService.reclaimOrphanBlobs(10)).toBe(0);
      expect(blobRepo.restoreClaimedBlob).toHaveBeenCalledWith('blob-err-1');
      expect(blobRepo.delete).not.toHaveBeenCalled();
    });

    it('configures R2-compatible lifecycle rules, binds x-amz-checksum-sha256 on S3 presign, and dispatches CleanupProcessor jobs', async () => {
      const s3 = new S3StorageAdapter({
        endpoint: 'https://acc123.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'flux',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      });

      const sha256Base64 = Buffer.from('a'.repeat(64), 'hex').toString(
        'base64',
      );
      const signedUrl = await s3.getPresignedUploadUrl(
        'uploads/staging/u1/paper.pdf',
        {
          mimeType: 'application/pdf',
          sizeBytes: 1234,
          checksumSha256Base64: sha256Base64,
        },
      );
      expect(signedUrl).toContain('x-amz-checksum-sha256=');

      const mockSend = jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          ContentLength: 1234,
          ContentType: 'application/pdf',
          ChecksumSHA256: sha256Base64,
          LastModified: new Date(),
        });
      (s3 as unknown as { client: { send: jest.Mock } }).client = {
        send: mockSend,
      };

      await s3.applyLifecycleRules();
      const lifecycleCmd = mockSend.mock
        .calls[0]?.[0] as PutBucketLifecycleConfigurationCommand;
      const rules =
        lifecycleCmd.input.LifecycleConfiguration?.Rules ?? [];
      const allTransitions = rules.flatMap((r) => r.Transitions ?? []);
      expect(
        allTransitions.some(
          (t) =>
            t.StorageClass === 'GLACIER' || t.StorageClass === 'DEEP_ARCHIVE',
        ),
      ).toBe(false);

      const meta = await s3.stat('uploads/staging/u1/paper.pdf');
      expect(meta.checksumSha256).toBe(sha256Base64);

      const { adapter } = createStorageMocks();
      const mockQueue = fromPartial<Queue>({
        on: jest.fn(),
        upsertJobScheduler: jest.fn().mockResolvedValue({}),
      });
      const processor = new CleanupProcessor(
        adapter,
        fromPartial<BlobService>({
          reclaimOrphanBlobs: jest.fn().mockResolvedValue(4),
        }),
        fromPartial<FilesUploadService>({
          cleanupExpiredSessions: jest.fn().mockResolvedValue(3),
          recoverStaleFinalizingSessions: jest.fn().mockResolvedValue(2),
          sweepUnpromotedStagingBlobs: jest.fn().mockResolvedValue(5),
        }),
        fromPartial<QuotaRepository>({
          reconcileSpaceQuotas: jest.fn().mockResolvedValue(2),
        }),
        mockQueue,
      );

      process.env.FILES_BOOTSTRAP_LIFECYCLE = 'false';
      await processor.onApplicationBootstrap();
      expect(adapter.applyLifecycleRules).not.toHaveBeenCalled();

      delete process.env.FILES_BOOTSTRAP_LIFECYCLE;
      await processor.onApplicationBootstrap();
      expect(adapter.applyLifecycleRules).toHaveBeenCalledTimes(1);
      expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(5);

      await expect(
        processor.process(fromPartial<Job>({ name: FILE_JOBS.CLEANUP_SESSIONS })),
      ).resolves.toBe(3);
      await expect(
        processor.process(fromPartial<Job>({ name: FILE_JOBS.RECLAIM_BLOBS })),
      ).resolves.toBe(4);
      await expect(
        processor.process(fromPartial<Job>({ name: FILE_JOBS.RECONCILE_QUOTAS })),
      ).resolves.toBe(2);
      await expect(
        processor.process(fromPartial<Job>({ name: FILE_JOBS.RECOVER_STALE })),
      ).resolves.toBe(2);
      await expect(
        processor.process(fromPartial<Job>({ name: FILE_JOBS.SWEEP_STAGING })),
      ).resolves.toBe(5);
      await expect(
        processor.process(fromPartial<Job>({ name: 'unknown-job' })),
      ).resolves.toBeNull();
    });
  });

  describe('Quota, Presigned Idempotency, BlobRef & Delivery Security', () => {
    it('accounts for pending upload reservations and enforces MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER in QuotaRepository', async () => {
      const spaceId = '11111111-1111-4111-8111-111111111111';
      const userId = '22222222-2222-4222-8222-222222222222';
      const countFn = jest.fn().mockResolvedValue(3);
      const mockPrisma = fromPartial<PrismaService>({
        spaceQuota: {
          findUnique: jest.fn().mockResolvedValue({
            spaceId,
            usedBytes: 2n * 1024n * 1024n * 1024n,
            maxBytes: 5n * 1024n * 1024n * 1024n,
            updatedAt: new Date(),
          }),
        },
        fileUpload: {
          aggregate: jest.fn().mockResolvedValue({
            _sum: { totalSize: 2800n * 1024n * 1024n },
          }),
          count: countFn,
        },
      });

      const quotaRepo = new QuotaRepository(mockPrisma);

      await expect(
        quotaRepo.assertAvailable(spaceId, 100n * 1024n * 1024n, {
          userId,
          enforceSessionCap: true,
        }),
      ).resolves.toBeUndefined();

      await expect(
        quotaRepo.assertAvailable(spaceId, 500n * 1024n * 1024n, {
          userId,
          enforceSessionCap: true,
        }),
      ).rejects.toThrow('Storage quota exceeded');

      countFn.mockResolvedValue(MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER);
      await expect(
        quotaRepo.assertAvailable(spaceId, 1024n, {
          userId,
          enforceSessionCap: true,
        }),
      ).rejects.toThrow(
        `Too many active upload sessions (max ${MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER})`,
      );
    });

    it('attributes space quota, deduplicates attachBlobRef/detachBlobRef per owner tuple, and returns personal/project quota summaries', async () => {
      const projectUuid = '11111111-1111-4111-8111-111111111111';
      const { quotaRepo, blobRepo, facade } = createStorageMocks();
      quotaRepo.findBySpaceId.mockImplementation(async (spaceId) => {
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

      const controller = new FilesController(facade);
      await expect(controller.getQuota('user-1')).resolves.toMatchObject({
        usedBytes: 0,
        maxBytes: Number(DEFAULT_STORAGE_QUOTA_BYTES),
        scope: 'personal',
        spaceId: 'user-1',
      });
      await expect(
        controller.getQuota('user-1', projectUuid),
      ).resolves.toMatchObject({
        usedBytes: 250 * 1024 * 1024,
        usagePercent: 25,
        scope: 'project',
        spaceId: projectUuid,
      });

      const pdfBytes = Buffer.from('%PDF-1.7\nhello space!');
      const uploaded = await facade.uploadFile({
        userId: 'system',
        spaceId: projectUuid,
        filename: 'fulltext.json.gz',
        buffer: pdfBytes,
        mimeType: 'application/gzip',
      });
      expect(quotaRepo.incrementUsage).toHaveBeenCalledWith(
        projectUuid,
        BigInt(pdfBytes.length),
      );

      await facade.deleteFile(uploaded.fileId, { spaceId: projectUuid });
      expect(quotaRepo.decrementUsage).toHaveBeenCalledWith(
        projectUuid,
        BigInt(pdfBytes.length),
      );

      // Idempotent attachBlobRef / detachBlobRef
      const refs = new Map<string, BlobRefRecord>();
      quotaRepo.incrementUsage.mockClear();
      quotaRepo.decrementUsage.mockClear();
      blobRepo.incrementRefCount.mockResolvedValue(
        makeBlobRecord({ id: 'blob-1', contentHashHex: 'a'.repeat(64) }),
      );
      blobRepo.attachRef.mockImplementation(async (input) => {
        const k = `${input.ownerType}:${input.ownerId}`;
        const existing = refs.get(k);
        if (existing) return { created: false, ref: existing };
        const rec: BlobRefRecord = {
          blobId: input.blobId,
          spaceId: input.spaceId,
          ownerType: input.ownerType,
          ownerId: input.ownerId,
          sizeBytes: input.sizeBytes ?? 0n,
          createdAt: new Date(),
        };
        refs.set(k, rec);
        return { created: true, ref: rec };
      });
      blobRepo.detachRef.mockImplementation(async (ownerType, ownerId) => {
        const k = `${ownerType}:${ownerId}`;
        const existing = refs.get(k) ?? null;
        if (existing) refs.delete(k);
        return existing;
      });
      blobRepo.existsInSpace.mockImplementation(async () => refs.size > 0);

      const refInput = {
        blobId: 'blob-1',
        spaceId: 'space-1',
        ownerType: 'attachment',
        ownerId: 'att-99',
        sizeBytes: 500n,
      };
      expect((await facade.attachBlobRef(refInput)).created).toBe(true);
      expect((await facade.attachBlobRef(refInput)).created).toBe(false);
      expect(quotaRepo.incrementUsage).toHaveBeenCalledTimes(1);

      expect(await facade.detachBlobRef('attachment', 'att-99')).toBe(true);
      expect(await facade.detachBlobRef('attachment', 'att-99')).toBe(false);
      expect(quotaRepo.decrementUsage).toHaveBeenCalledTimes(1);
    });

    it('replays completePresignedUpload from Redis & DB fallback, rejects concurrent locks with 409, and deletes staging on over-quota', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-presign-'));
      try {
        const localAdapter = new LocalStorageAdapter(tempDir);
        const { blobRepo, quotaRepo, sessionRepo } = createStorageMocks();
        const store = new Map<string, unknown>();
        const locks = new Set<string>();
        const redisSet = jest.fn(async (key: string, val: unknown) => {
          store.set(key, val);
        });
        const redis = fromPartial<RedisCacheService>({
          get: jest.fn(async (key: string) => (store.get(key) as never) ?? null),
          set: redisSet,
        });
        const lockService = fromPartial<DistributedLockService>({
          acquireLock: jest.fn(async (resource: string) => {
            if (locks.has(resource)) return null;
            locks.add(resource);
            return `token-${resource}`;
          }),
          releaseLock: jest.fn(async (resource: string) => {
            locks.delete(resource);
            return true;
          }),
        });

        const blobService = new BlobService(localAdapter, blobRepo);
        const uploadService = new FilesUploadService(
          localAdapter,
          blobService,
          blobRepo,
          quotaRepo,
          sessionRepo,
          fromPartial<Queue>({ add: jest.fn().mockResolvedValue({}) }),
          redis,
          lockService,
        );

        const payload = Buffer.from('%PDF-1.7\npresigned-idempotent');
        const stagingKey = 'uploads/staging/user-1/idem-doc.pdf';
        await localAdapter.put(stagingKey, payload);

        const first = await uploadService.completePresignedUpload({
          userId: 'user-1',
          storageKey: stagingKey,
          filename: 'idem-doc.pdf',
          mimeType: 'application/pdf',
          sizeBytes: payload.length,
        });
        expect(redisSet).toHaveBeenCalledWith(
          expect.stringMatching(/^files:idem:complete:/),
          expect.objectContaining({ blobId: first.blobId }),
          PRESIGN_COMPLETE_IDEM_TTL_SECONDS,
        );

        const second = await uploadService.completePresignedUpload({
          userId: 'user-1',
          storageKey: stagingKey,
          filename: 'idem-doc.pdf',
          mimeType: 'application/pdf',
        });
        expect(second.blobId).toBe(first.blobId);

        store.clear();
        const dbReplay = await uploadService.completePresignedUpload({
          userId: 'user-1',
          storageKey: stagingKey,
          filename: 'idem-doc.pdf',
          mimeType: 'application/pdf',
        });
        expect(dbReplay.blobId).toBe(first.blobId);
        expect(quotaRepo.incrementUsage).toHaveBeenCalledTimes(1);

        const lockedKey = 'uploads/staging/user-1/locked-doc.pdf';
        const digest = crypto
          .createHash('sha256')
          .update(`user-1:${lockedKey}`)
          .digest('hex')
          .slice(0, 32);
        locks.add(`files:complete:${digest}`);
        await expect(
          uploadService.completePresignedUpload({
            userId: 'user-1',
            storageKey: lockedKey,
            filename: 'locked-doc.pdf',
          }),
        ).rejects.toThrow(ConflictException);

        // Over-quota cleanup
        const overQuotaKey = 'uploads/staging/user-1/over-quota.pdf';
        await localAdapter.put(overQuotaKey, payload);
        quotaRepo.incrementUsage.mockRejectedValueOnce(
          new BadRequestException('Storage quota exceeded'),
        );
        await expect(
          uploadService.completePresignedUpload({
            userId: 'user-1',
            storageKey: overQuotaKey,
            filename: 'over-quota.pdf',
            mimeType: 'application/pdf',
          }),
        ).rejects.toThrow('Storage quota exceeded');
        expect(await localAdapter.exists(overQuotaKey)).toBe(false);
      } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('enforces BOLA, cross-space Hash Oracle defense, path traversal blocks, signed HMAC capabilities, and default 302 offload', async () => {
      const targetSpace = '44444444-4444-4444-8444-444444444444';
      const blobId = '33333333-3333-4333-8333-333333333333';
      const hashHex = ContentHash.fromBuffer(
        Buffer.from('private-paper'),
      ).toHex();
      const {
        blobs,
        adapter,
        blobRepo,
        uploadService,
        accessService,
        facade,
      } = createStorageMocks();

      const blob = makeBlobRecord({
        id: blobId,
        contentHashHex: hashHex,
        sizeBytes: 120n,
        mimeType: 'application/pdf',
      });
      blobs.set(blobId, blob);

      // Cross-space Hash Oracle defense
      blobRepo.hasSpaceAccessToBlob.mockResolvedValueOnce(false);
      const presignProbe = await uploadService.presignUpload({
        userId: 'attacker',
        spaceId: 'other-space',
        filename: 'probe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 120,
        contentHash: hashHex,
      });
      expect(presignProbe.deduplicated).toBe(false);

      // Cross-space BOLA on controller endpoints
      const controller = new FilesController(facade);
      blobRepo.hasUserAccessToSpace.mockResolvedValue(false);
      await expect(
        controller.presign('outsider', {
          filename: 'doc.pdf',
          spaceId: targetSpace,
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.initiateMultipart('outsider', {
          filename: 'doc.bin',
          totalSize: 1024,
          spaceId: targetSpace,
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.getQuota('outsider', targetSpace),
      ).rejects.toThrow(ForbiddenException);

      // Path traversal & restricted prefix blocks on streamObjectByKey
      const makeMockReply = () => {
        const headers = new Map<string, unknown>();
        const state = { status: 0, body: undefined as unknown };
        const reply: FastifyReply = fromPartial<FastifyReply>({
          status: jest.fn((c: number) => {
            state.status = c;
            return reply;
          }),
          header: jest.fn((k: string, v: unknown) => {
            headers.set(k.toLowerCase(), v);
            return reply;
          }),
          send: jest.fn((b?: unknown) => {
            state.body = b;
            return reply;
          }),
        });
        return { reply, state, headers };
      };

      for (const blockedUrl of [
        '/api/v1/files/objects/..%2F..%2Fetc%2Fpasswd',
        '/api/v1/files/objects/backups%2Fproject-backup.zip',
        '/api/v1/files/objects/uploads%2Fstaging%2Fsecret.bin',
        '/api/v1/files/objects/blobs%2Fe3%2Fb0%2Fsecret-hash',
      ]) {
        const { reply, state } = makeMockReply();
        await controller.streamObjectByKey(
          fromPartial<FastifyRequest>({ url: blockedUrl, headers: {} }),
          reply,
        );
        expect(state.status).toBe(403);
      }

      // Derivative HMAC enforcement vs public allowlist
      adapter.getStream.mockResolvedValue({
        stream: Readable.from([Buffer.from('webp-bytes')]),
        contentLength: 10,
      });
      const derivKey = `derivatives/aa/aa/${'a'.repeat(64)}/thumb.webp`;
      const anonDeriv = makeMockReply();
      await controller.streamObjectByKey(
        fromPartial<FastifyRequest>({
          url: `/api/v1/files/objects/${encodeURIComponent(derivKey)}`,
          headers: {},
          query: {},
        }),
        anonDeriv.reply,
      );
      expect(anonDeriv.state.status).toBe(401);

      const signedDerivPath = accessService.signObjectUrl(derivKey, 300);
      const parsedDeriv = new URL(signedDerivPath, 'http://localhost');
      const signedDeriv = makeMockReply();
      await controller.streamObjectByKey(
        fromPartial<FastifyRequest>({
          url: signedDerivPath,
          headers: {},
          query: {
            exp: parsedDeriv.searchParams.get('exp'),
            sig: parsedDeriv.searchParams.get('sig'),
          },
        }),
        signedDeriv.reply,
      );
      expect(signedDeriv.state.status).toBe(200);

      // Blob content BOLA (401/403), capability URL (200), and direct-download 302 offload vs proxy opt-out
      blobRepo.hasUserAccessToBlob.mockResolvedValue(false);
      await expect(
        controller.streamBlobContent(
          blobId,
          'paper.pdf',
          undefined,
          fromPartial<FastifyRequest>({
            url: `/api/v1/files/${blobId}/content`,
            headers: {},
          }),
          makeMockReply().reply,
        ),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        controller.getDirectDownloadUrl('outsider', blobId, 'paper.pdf'),
      ).rejects.toThrow(ForbiddenException);

      const capUrl = accessService.signBlobUrl(blobId, {
        expiresInSeconds: 120,
        filename: 'paper.pdf',
      });
      const parsedCap = new URL(capUrl, 'http://localhost');
      const capReply = makeMockReply();
      await controller.streamBlobContent(
        blobId,
        'paper.pdf',
        undefined,
        fromPartial<FastifyRequest>({ url: capUrl, headers: {} }),
        capReply.reply,
        parsedCap.searchParams.get('exp')!,
        parsedCap.searchParams.get('sig')!,
      );
      expect(capReply.state.status).toBe(200);

      // Default 302 offload when supportsDirectDownload = true, and proxy stream on redirect: false
      (adapter as { supportsDirectDownload?: boolean }).supportsDirectDownload =
        true;
      adapter.getPresignedDownloadUrl.mockResolvedValue(
        'https://r2.signed.example/paper.pdf',
      );
      blobRepo.hasUserAccessToBlob.mockResolvedValue(true);

      await expect(
        facade.resolveAuthorizedBlobContent({
          blobId,
          userId: 'owner-1',
          isDownload: false,
        }),
      ).resolves.toEqual({
        kind: 'redirect',
        location: 'https://r2.signed.example/paper.pdf',
      });

      const proxied = await facade.resolveAuthorizedBlobContent({
        blobId,
        userId: 'owner-1',
        isDownload: false,
        redirect: false,
      });
      expect(proxied.kind).toBe('stream');
    });

    it('enforces post-auth per-user burst rate limits on FilesController without pre-auth double counting', async () => {
      const reflector = new Reflector();
      const configService = new RateLimitConfigService(
        fromPartial({ get: () => undefined }),
      );
      const guard = new UserRateLimitGuard(reflector, configService);
      guard.resetMemoryBuckets();

      const getRules = (methodName: keyof FilesController) =>
        reflector.getAllAndOverride<UserRateLimitRule[]>(USER_RATE_LIMIT_KEY, [
          FilesController.prototype[methodName] as never,
          FilesController,
        ]);

      expect(getRules('presign')).toEqual([
        { bucket: 'files-presign', keyType: 'user' },
      ]);
      expect(getRules('streamBlobContent')).toEqual([
        { bucket: 'files-download', keyType: 'user-or-ip' },
      ]);

      const createPresignContext = (userId?: string): ExecutionContext =>
        fromPartial<ExecutionContext>({
          switchToHttp: () => ({
            getRequest: () => ({
              ip: '10.0.0.5',
              user: userId ? { id: userId } : undefined,
            }),
            getResponse: () => ({ header: jest.fn(), setHeader: jest.fn() }),
          }),
          getHandler: () => FilesController.prototype.presign,
          getClass: () => FilesController,
        });

      for (let i = 0; i < 5; i++) {
        await expect(guard.canActivate(createPresignContext())).resolves.toBe(
          true,
        );
      }
      for (let i = 0; i < 60; i++) {
        await expect(
          guard.canActivate(createPresignContext('rate-user-1')),
        ).resolves.toBe(true);
      }

      let thrown: unknown;
      try {
        await guard.canActivate(createPresignContext('rate-user-1'));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpException);
      expect((thrown as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    });
  });
});
