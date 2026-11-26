import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Job, Queue } from 'bullmq';
import { Readable } from 'node:stream';
import {
  RateLimitConfigService,
  RedisCacheService,
  USER_RATE_LIMIT_KEY,
  UserRateLimitGuard,
  UserRateLimitRule,
} from '@/core';
import { BlobStatus, StorageBlobRecord, UploadSessionRecord, UploadSessionStatus } from '@/modules/files/types/files.type';
import {
  FILE_JOBS,
  MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER,
  PRESIGN_COMPLETE_IDEM_TTL_SECONDS,
  STALE_FINALIZING_LEASE_MINUTES,
  STAGING_DELETE_DELAY_MS,
} from '@/modules/files/files.constant';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import { FilesController } from '@/modules/files/controllers/files.controller';
import { CasProcessor } from '@/modules/files/processors/cas.processor';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';

function createStatefulHarness() {
  const blobs = new Map<string, StorageBlobRecord>();
  const sessions = new Map<string, UploadSessionRecord>();
  const enqueuedJobs: Array<{
    name: string;
    data: unknown;
    opts?: Record<string, unknown>;
  }> = [];
  let usedBytes = 0n;
  let maxBytes = 100n * 1024n * 1024n;

  const blobRepo = {
    findById: jest.fn(async (id: string) => blobs.get(id) ?? null),
    findByHash: jest.fn(async (hex: string) => {
      for (const blob of blobs.values()) {
        if (blob.contentHashHex === hex) return blob;
      }
      return null;
    }),
    findByStorageKey: jest.fn(async (key: string) => {
      for (const blob of blobs.values()) {
        if (blob.s3Key === key) return blob;
      }
      return null;
    }),
    existsByStorageKey: jest.fn(async (key: string) => {
      for (const blob of blobs.values()) {
        if (blob.s3Key === key) return true;
      }
      return false;
    }),
    create: jest.fn(async (input) => {
      const record: StorageBlobRecord = {
        id: input.id,
        contentHashHex: input.contentHashHex,
        hashAlgorithm: 'SHA256',
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
        checksumVerified: input.checksumVerified,
        s3Key: input.s3Key,
        s3Bucket: input.s3Bucket,
        storageClass: 'STANDARD',
        refCount: input.refCount ?? 1,
        status: input.status ?? BlobStatus.READY,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      };
      blobs.set(record.id, record);
      return record;
    }),
    promoteStorageLocation: jest.fn(async (input) => {
      const existing = blobs.get(input.blobId);
      if (!existing || existing.s3Key !== input.expectedCurrentKey) {
        return false;
      }
      blobs.set(input.blobId, {
        ...existing,
        s3Key: input.nextStorageKey,
        contentHashHex: input.nextContentHashHex ?? existing.contentHashHex,
        checksumVerified: input.checksumVerified,
      });
      return true;
    }),
    findUnpromotedStagingBlobs: jest.fn(
      async (olderThan: Date, limit: number) =>
        Array.from(blobs.values())
          .filter(
            (b) =>
              b.status === BlobStatus.READY &&
              b.s3Key.startsWith('uploads/staging/') &&
              b.createdAt < olderThan,
          )
          .slice(0, limit),
    ),
    incrementRefCount: jest.fn(async (id: string) => {
      const existing = blobs.get(id);
      if (!existing) return null;
      const updated = { ...existing, refCount: existing.refCount + 1 };
      blobs.set(id, updated);
      return updated;
    }),
    decrementRefCount: jest.fn().mockResolvedValue(null),
    hasSpaceAccessToBlob: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<BlobRepository>;

  const quotaRepo = {
    findBySpaceId: jest.fn(async (spaceId?: string | null) => ({
      spaceId: spaceId ?? 'user-1',
      usedBytes,
      maxBytes,
      updatedAt: new Date(),
    })),
    assertAvailable: jest.fn(async (_spaceId, requiredBytes: bigint) => {
      if (usedBytes + requiredBytes > maxBytes) {
        throw new BadRequestException('Storage quota exceeded');
      }
    }),
    incrementUsage: jest.fn(async (_spaceId, bytes: bigint) => {
      if (usedBytes + bytes > maxBytes) {
        throw new BadRequestException('Storage quota exceeded');
      }
      usedBytes += bytes;
      return usedBytes;
    }),
    decrementUsage: jest.fn(async (_spaceId, bytes: bigint) => {
      usedBytes = usedBytes > bytes ? usedBytes - bytes : 0n;
      return usedBytes;
    }),
  } as unknown as jest.Mocked<QuotaRepository>;

  const sessionRepo = {
    create: jest.fn(async (input) => {
      const totalParts =
        input.totalSize > 0n && input.partSize > 0
          ? Math.max(1, Math.ceil(Number(input.totalSize) / input.partSize))
          : 0;
      const rec: UploadSessionRecord = {
        id: input.id,
        spaceId: input.spaceId,
        userId: input.userId,
        s3UploadId: input.s3UploadId,
        s3Key: input.s3Key,
        filename: input.filename,
        mimeType: input.mimeType,
        totalSize: input.totalSize,
        partSize: input.partSize,
        totalParts,
        expectedHashHex: input.expectedHashHex ?? null,
        parentId: input.parentId ?? null,
        status: UploadSessionStatus.INITIALIZED,
        finalizingAt: null,
        resultBlobId: null,
        expiresAt: input.expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.set(rec.id, rec);
      return rec;
    }),
    findById: jest.fn(async (id: string) => sessions.get(id) ?? null),
    markStatus: jest.fn(async (id: string, status: UploadSessionStatus) => {
      const existing = sessions.get(id)!;
      const updated = { ...existing, status, updatedAt: new Date() };
      sessions.set(id, updated);
      return updated;
    }),
    markUploadingIfInitialized: jest.fn(async (id: string) => {
      const existing = sessions.get(id);
      if (!existing || existing.status !== UploadSessionStatus.INITIALIZED) {
        return false;
      }
      sessions.set(id, {
        ...existing,
        status: UploadSessionStatus.UPLOADING,
        updatedAt: new Date(),
      });
      return true;
    }),
    claimForFinalizing: jest.fn(async (id: string) => {
      const existing = sessions.get(id);
      if (
        !existing ||
        (existing.status !== UploadSessionStatus.INITIALIZED &&
          existing.status !== UploadSessionStatus.UPLOADING) ||
        existing.expiresAt.getTime() <= Date.now()
      ) {
        return false;
      }
      sessions.set(id, {
        ...existing,
        status: UploadSessionStatus.FINALIZING,
        finalizingAt: new Date(),
        updatedAt: new Date(),
      });
      return true;
    }),
    markCompletedWithBlob: jest.fn(async (id: string, blobId: string) => {
      const existing = sessions.get(id)!;
      const updated: UploadSessionRecord = {
        ...existing,
        status: UploadSessionStatus.COMPLETED,
        resultBlobId: blobId,
        finalizingAt: null,
        updatedAt: new Date(),
      };
      sessions.set(id, updated);
      return updated;
    }),
    releaseFinalizingToUploading: jest.fn(async (id: string) => {
      const existing = sessions.get(id);
      if (!existing || existing.status !== UploadSessionStatus.FINALIZING) {
        return false;
      }
      sessions.set(id, {
        ...existing,
        status: UploadSessionStatus.UPLOADING,
        finalizingAt: null,
        updatedAt: new Date(),
      });
      return true;
    }),
    findStaleFinalizingSessions: jest.fn(
      async (staleBefore: Date, limit: number) =>
        Array.from(sessions.values())
          .filter(
            (s) =>
              s.status === UploadSessionStatus.FINALIZING &&
              s.finalizingAt &&
              s.finalizingAt < staleBefore,
          )
          .slice(0, limit),
    ),
    findExpiredSessions: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<SessionRepository>;

  const finalizeCasQueue = {
    add: jest.fn(
      async (name: string, data: unknown, opts?: Record<string, unknown>) => {
        enqueuedJobs.push({ name, data, opts });
        return { id: opts?.jobId ?? `${name}-${enqueuedJobs.length}` };
      },
    ),
  };

  return {
    blobs,
    sessions,
    enqueuedJobs,
    finalizeCasQueue,
    blobRepo,
    quotaRepo,
    sessionRepo,
    getUsedBytes: () => usedBytes,
    setMaxBytes: (next: bigint) => {
      maxBytes = next;
    },
  };
}

function createMockRedis(): jest.Mocked<RedisCacheService> & {
  store: Map<string, unknown>;
  locks: Set<string>;
} {
  const store = new Map<string, unknown>();
  const locks = new Set<string>();
  return {
    store,
    locks,
    get: jest.fn(async (key: string) => (store.get(key) as never) ?? null),
    set: jest.fn(async (key: string, val: unknown) => {
      store.set(key, val);
    }),
    acquireLock: jest.fn(async (resource: string) => {
      if (locks.has(resource)) return null;
      locks.add(resource);
      return `token-${resource}`;
    }),
    releaseLock: jest.fn(async (resource: string) => {
      locks.delete(resource);
      return true;
    }),
  } as unknown as jest.Mocked<RedisCacheService> & {
    store: Map<string, unknown>;
    locks: Set<string>;
  };
}

function createMockDriver(): jest.Mocked<IStorageAdapter> {
  return {
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
    getPresignedPartUploadUrl: jest
      .fn()
      .mockResolvedValue('https://signed/part'),
    completeMultipartUpload: jest.fn().mockResolvedValue({ eTag: 'mpu-etag' }),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    listUploadedParts: jest.fn().mockResolvedValue([]),
    applyLifecycleRules: jest.fn().mockResolvedValue(undefined),
    getLifecycleRules: jest.fn().mockResolvedValue(null),
  };
}

describe('FilesModule P0 Production Hardening', () => {
  let tempDir: string;
  let localAdapter: LocalStorageAdapter;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-files-p0-'));
    localAdapter = new LocalStorageAdapter(tempDir);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('1. Concurrent completeMultipart Race & Idempotent Replay', () => {
    it('allows only one atomic claim across 5 parallel complete calls and replays idempotently once COMPLETED', async () => {
      const harness = createStatefulHarness();
      const blobService = new BlobService(localAdapter, harness.blobRepo);
      const uploadService = new FilesUploadService(
        localAdapter,
        blobService,
        harness.blobRepo,
        harness.quotaRepo,
        harness.sessionRepo,
        harness.finalizeCasQueue as unknown as Queue,
      );

      const payload = Buffer.from('%PDF-1.7\nconcurrent-complete-payload');
      const init = await uploadService.initiateMultipart({
        userId: 'user-1',
        filename: 'race-test.pdf',
        mimeType: 'application/pdf',
        totalSize: payload.length,
      });
      const part = await localAdapter.putPart(init.uploadId, 1, payload);

      const originalStat = localAdapter.stat.bind(localAdapter);
      jest.spyOn(localAdapter, 'stat').mockImplementation(async (key) => {
        await new Promise((r) => setTimeout(r, 25));
        return originalStat(key);
      });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          uploadService.completeMultipart({
            sessionId: init.sessionId,
            parts: [{ partNumber: 1, eTag: part.eTag }],
            actor: { userId: 'user-1' },
          }),
        ),
      );

      const fulfilled = outcomes.filter(
        (
          o,
        ): o is PromiseFulfilledResult<
          Awaited<ReturnType<FilesUploadService['completeMultipart']>>
        > => o.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      for (const r of rejected) {
        const reason: unknown = r.reason;
        expect(reason).toBeInstanceOf(ConflictException);
        const body = (reason as ConflictException).getResponse() as {
          retryAfter?: number;
        };
        expect(body.retryAfter).toBe(2);
      }
      expect(harness.quotaRepo.incrementUsage).toHaveBeenCalledTimes(1);
      expect(harness.blobRepo.create).toHaveBeenCalledTimes(1);
      expect(harness.getUsedBytes()).toBe(BigInt(payload.length));

      const winnerResult = fulfilled[0].value;

      const replay = await uploadService.completeMultipart({
        sessionId: init.sessionId,
        parts: [{ partNumber: 1, eTag: part.eTag }],
        actor: { userId: 'user-1' },
      });

      expect(replay.blobId).toBe(winnerResult.blobId);
      expect(replay.fileId).toBe(winnerResult.fileId);
      expect(harness.quotaRepo.incrementUsage).toHaveBeenCalledTimes(1);
      expect(harness.blobRepo.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Client Size Spoofing & Mandatory driver.stat() Verification', () => {
    it('charges quota and records FileBlob using actual stat.size rather than spoofed session.totalSize', async () => {
      const harness = createStatefulHarness();
      const blobService = new BlobService(localAdapter, harness.blobRepo);
      const uploadService = new FilesUploadService(
        localAdapter,
        blobService,
        harness.blobRepo,
        harness.quotaRepo,
        harness.sessionRepo,
        harness.finalizeCasQueue as unknown as Queue,
      );

      const actualPayload = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.alloc(2040, 0x61),
      ]);
      const init = await uploadService.initiateMultipart({
        userId: 'user-1',
        filename: 'spoof.pdf',
        mimeType: 'application/pdf',
        totalSize: 100, // client declared 100 bytes
      });
      const part = await localAdapter.putPart(init.uploadId, 1, actualPayload);

      const res = await uploadService.completeMultipart({
        sessionId: init.sessionId,
        parts: [{ partNumber: 1, eTag: part.eTag }],
        actor: { userId: 'user-1' },
      });

      expect(res.size).toBe(actualPayload.length);
      expect(harness.quotaRepo.incrementUsage).toHaveBeenCalledWith(
        'user-1',
        BigInt(actualPayload.length),
      );
      expect(harness.blobs.get(res.blobId)?.sizeBytes).toBe(
        BigInt(actualPayload.length),
      );
    });

    it('deletes staging object and releases FINALIZING lock when actual stat.size exceeds quota', async () => {
      const harness = createStatefulHarness();
      harness.setMaxBytes(500n);
      const blobService = new BlobService(localAdapter, harness.blobRepo);
      const uploadService = new FilesUploadService(
        localAdapter,
        blobService,
        harness.blobRepo,
        harness.quotaRepo,
        harness.sessionRepo,
        harness.finalizeCasQueue as unknown as Queue,
      );

      const actualPayload = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.alloc(1024, 0x62),
      ]);
      const init = await uploadService.initiateMultipart({
        userId: 'user-1',
        filename: 'over-quota-spoof.pdf',
        mimeType: 'application/pdf',
        totalSize: 100, // passes initial assertAvailable (100 <= 500)
      });
      const part = await localAdapter.putPart(init.uploadId, 1, actualPayload);

      await expect(
        uploadService.completeMultipart({
          sessionId: init.sessionId,
          parts: [{ partNumber: 1, eTag: part.eTag }],
          actor: { userId: 'user-1' },
        }),
      ).rejects.toThrow('Storage quota exceeded');

      expect(await localAdapter.exists(init.storageKey)).toBe(false);
      expect(harness.sessions.get(init.sessionId)?.status).toBe(
        UploadSessionStatus.UPLOADING,
      );
      expect(harness.blobs.size).toBe(0);
    });
  });

  describe('3. completePresignedUpload Redis Idempotency & DB Fallback', () => {
    it('replays from Redis cache on duplicate calls, rejects concurrent in-flight lock with 409, and supports DB fallback', async () => {
      const harness = createStatefulHarness();
      const redis = createMockRedis();
      const blobService = new BlobService(localAdapter, harness.blobRepo);
      const uploadService = new FilesUploadService(
        localAdapter,
        blobService,
        harness.blobRepo,
        harness.quotaRepo,
        harness.sessionRepo,
        harness.finalizeCasQueue as unknown as Queue,
        redis,
        redis as unknown as import('@/core').DistributedLockService,
      );

      const payload = Buffer.from('%PDF-1.7\npresigned-idempotent');
      const stagingKey = 'uploads/staging/user-1/idem-doc.pdf';
      await localAdapter.put(stagingKey, payload, {
        mimeType: 'application/pdf',
        size: payload.length,
      });

      const first = await uploadService.completePresignedUpload({
        userId: 'user-1',
        storageKey: stagingKey,
        filename: 'idem-doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: payload.length,
      });

      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^files:idem:complete:/),
        expect.objectContaining({ blobId: first.blobId }),
        PRESIGN_COMPLETE_IDEM_TTL_SECONDS,
      );

      const statSpy = jest.spyOn(localAdapter, 'stat');
      const second = await uploadService.completePresignedUpload({
        userId: 'user-1',
        storageKey: stagingKey,
        filename: 'idem-doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: payload.length,
      });

      expect(second.blobId).toBe(first.blobId);
      expect(statSpy).not.toHaveBeenCalled();
      expect(harness.quotaRepo.incrementUsage).toHaveBeenCalledTimes(1);

      // Clear Redis cache to test DB findByStorageKey fallback
      redis.store.clear();
      const third = await uploadService.completePresignedUpload({
        userId: 'user-1',
        storageKey: stagingKey,
        filename: 'idem-doc.pdf',
        mimeType: 'application/pdf',
      });
      expect(third.blobId).toBe(first.blobId);
      expect(harness.quotaRepo.incrementUsage).toHaveBeenCalledTimes(1);

      // Simulate held in-flight distributed lock for a new key with empty cache
      const lockedKey = 'uploads/staging/user-1/locked-doc.pdf';
      const digest = crypto
        .createHash('sha256')
        .update(`user-1:${lockedKey}`)
        .digest('hex')
        .slice(0, 32);
      redis.locks.add(`files:complete:${digest}`);

      await expect(
        uploadService.completePresignedUpload({
          userId: 'user-1',
          storageKey: lockedKey,
          filename: 'locked-doc.pdf',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('4. Pending Upload Quota Reservation & Per-User Active Session Cap', () => {
    it('includes active file_uploads totalSize in assertAvailable and enforces MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER', async () => {
      const spaceId = '11111111-1111-4111-8111-111111111111';
      const userId = '22222222-2222-4222-8222-222222222222';
      const maxQuota = 5n * 1024n * 1024n * 1024n;
      const usedQuota = 2n * 1024n * 1024n * 1024n;
      const pendingQuota = 2800n * 1024n * 1024n; // ~2.73 GB

      const mockPrisma = {
        spaceQuota: {
          findUnique: jest.fn().mockResolvedValue({
            spaceId,
            usedBytes: usedQuota,
            maxBytes: maxQuota,
            updatedAt: new Date(),
          }),
        },
        fileUpload: {
          aggregate: jest.fn().mockResolvedValue({
            _sum: { totalSize: pendingQuota },
          }),
          count: jest.fn().mockResolvedValue(3),
        },
      };

      const quotaRepo = new QuotaRepository(mockPrisma as never);

      // 2GB + 2.73GB + 100MB <= 5GB -> allowed
      await expect(
        quotaRepo.assertAvailable(spaceId, 100n * 1024n * 1024n, {
          userId,
          enforceSessionCap: true,
        }),
      ).resolves.toBeUndefined();

      // 2GB + 2.73GB + 500MB > 5GB -> rejected
      await expect(
        quotaRepo.assertAvailable(spaceId, 500n * 1024n * 1024n, {
          userId,
          enforceSessionCap: true,
        }),
      ).rejects.toThrow('Storage quota exceeded');

      // Active session cap reached
      mockPrisma.fileUpload.count.mockResolvedValue(
        MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER,
      );
      await expect(
        quotaRepo.assertAvailable(spaceId, 1024n, {
          userId,
          enforceSessionCap: true,
        }),
      ).rejects.toThrow(
        `Too many active upload sessions (max ${MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER})`,
      );
    });
  });

  describe('5. Fast-Finalize, Async CAS Promotion, P2002 Collision Isolation & Delayed Delete Safety', () => {
    it('skips sync stream hashing/copy on Fast-Finalize and promotes cleanly in worker', async () => {
      const driver = createMockDriver();
      const harness = createStatefulHarness();
      const blobService = new BlobService(driver, harness.blobRepo);

      const res = await blobService.registerStagingObjectFast({
        storageKey: 'uploads/staging/u1/doc.pdf',
        sizeBytes: 2048n,
        mimeType: 'application/pdf',
        checksumVerified: false,
      });

      expect(res.needsAsyncPromotion).toBe(true);
      expect(res.blob.status).toBe(BlobStatus.READY);
      expect(res.blob.s3Key).toBe('uploads/staging/u1/doc.pdf');
      expect(driver.getStream).not.toHaveBeenCalled();
      expect(driver.copy).not.toHaveBeenCalled();
    });

    it('isolates post-facto P2002 hash collision into blobs/raw without deleting winner CAS key and guards delayed delete', async () => {
      const harness = createStatefulHarness();
      const blobService = new BlobService(localAdapter, harness.blobRepo);
      const casProcessor = new CasProcessor(
        localAdapter,
        blobService,
        harness.blobRepo,
        harness.finalizeCasQueue as unknown as Queue,
      );

      const payload = Buffer.from('%PDF-1.7\nidentical-concurrent-upload');
      const shaHex = ContentHash.fromBuffer(payload).toHex();
      const winnerCanonicalKey = StorageKey.forBlob(shaHex).value();

      const key1 = 'uploads/staging/u1/copy1.pdf';
      const key2 = 'uploads/staging/u2/copy2.pdf';
      await localAdapter.put(key1, payload, { mimeType: 'application/pdf' });
      await localAdapter.put(key2, payload, { mimeType: 'application/pdf' });

      const fast1 = await blobService.registerStagingObjectFast({
        storageKey: key1,
        sizeBytes: BigInt(payload.length),
        mimeType: 'application/pdf',
        checksumVerified: false,
      });
      const fast2 = await blobService.registerStagingObjectFast({
        storageKey: key2,
        sizeBytes: BigInt(payload.length),
        mimeType: 'application/pdf',
        checksumVerified: false,
      });

      // Promote blob 1 normally to canonical CAS
      await casProcessor.process({
        id: 'promote-1',
        name: FILE_JOBS.PROMOTE_CAS,
        data: { blobId: fast1.blob.id, stagingKey: key1 },
      } as Job);
      expect(harness.blobs.get(fast1.blob.id)?.s3Key).toBe(winnerCanonicalKey);
      expect(await localAdapter.exists(winnerCanonicalKey)).toBe(true);

      // Simulate race where findByHash initially missed before promoteStorageLocation hit P2002 on blob 2
      jest.spyOn(harness.blobRepo, 'findByHash').mockResolvedValueOnce(null);
      const originalPromote = harness.blobRepo.promoteStorageLocation;
      harness.blobRepo.promoteStorageLocation = jest
        .fn()
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockImplementationOnce(originalPromote);

      const collisionRes = (await casProcessor.process({
        id: 'promote-2',
        name: FILE_JOBS.PROMOTE_CAS,
        data: { blobId: fast2.blob.id, stagingKey: key2 },
      } as Job)) as { promoted: boolean; isolated: boolean; finalKey?: string };

      const expectedIsolatedKey = StorageKey.forUnhashedBlob(
        fast2.blob.id,
      ).value();
      expect(collisionRes.promoted).toBe(true);
      expect(collisionRes.isolated).toBe(true);
      expect(collisionRes.finalKey).toBe(expectedIsolatedKey);
      expect(harness.blobs.get(fast2.blob.id)?.s3Key).toBe(expectedIsolatedKey);
      expect(harness.blobs.get(fast2.blob.id)?.checksumVerified).toBe(true);
      expect(await localAdapter.exists(expectedIsolatedKey)).toBe(true);
      // Winner CAS object MUST remain untouched!
      expect(await localAdapter.exists(winnerCanonicalKey)).toBe(true);

      // Enqueued delayed delete must specify STAGING_DELETE_DELAY_MS
      const delJobs = harness.enqueuedJobs.filter(
        (j) => j.name === FILE_JOBS.DELETE_STAGING,
      );
      expect(delJobs).toHaveLength(2);
      expect(delJobs[1].opts?.delay).toBe(STAGING_DELETE_DELAY_MS);

      // Delayed delete safety guard: refuse deletion if a FileBlob still points to staging key
      const unpromotedKey = 'uploads/staging/u3/still-referenced.pdf';
      await localAdapter.put(unpromotedKey, payload);
      await blobService.registerStagingObjectFast({
        storageKey: unpromotedKey,
        sizeBytes: BigInt(payload.length),
        checksumVerified: false,
      });

      const refused = await casProcessor.process({
        id: 'del-guard-1',
        name: FILE_JOBS.DELETE_STAGING,
        data: { storageKey: unpromotedKey },
      } as Job);
      expect(refused).toBe(false);
      expect(await localAdapter.exists(unpromotedKey)).toBe(true);

      // Once staging key is no longer referenced in DB, delayed delete removes it
      const deleted = await casProcessor.process({
        id: 'del-ok-2',
        name: FILE_JOBS.DELETE_STAGING,
        data: { storageKey: key2 },
      } as Job);
      expect(deleted).toBe(true);
      expect(await localAdapter.exists(key2)).toBe(false);
    });
  });

  describe('6. Maintenance Recovery, Sweep & Control Plane Rate Limiting', () => {
    it('recovers stale FINALIZING sessions and sweeps unpromoted staging blobs', async () => {
      const driver = createMockDriver();
      const harness = createStatefulHarness();
      const blobService = new BlobService(driver, harness.blobRepo);
      const uploadService = new FilesUploadService(
        driver,
        blobService,
        harness.blobRepo,
        harness.quotaRepo,
        harness.sessionRepo,
        harness.finalizeCasQueue as unknown as Queue,
      );

      const staleTimestamp = new Date(
        Date.now() - (STALE_FINALIZING_LEASE_MINUTES + 2) * 60_000,
      );
      harness.sessions.set('stale-active', {
        id: 'stale-active',
        spaceId: 'user-1',
        userId: 'user-1',
        s3UploadId: 'mpu-active',
        s3Key: 'uploads/staging/multipart/stale-active/payload.bin',
        filename: 'active.bin',
        mimeType: 'application/octet-stream',
        totalSize: 1024n,
        partSize: 5_242_880,
        totalParts: 1,
        expectedHashHex: null,
        parentId: null,
        status: UploadSessionStatus.FINALIZING,
        finalizingAt: staleTimestamp,
        resultBlobId: null,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: staleTimestamp,
        updatedAt: staleTimestamp,
      });

      harness.sessions.set('stale-expired', {
        id: 'stale-expired',
        spaceId: 'user-1',
        userId: 'user-1',
        s3UploadId: 'mpu-expired',
        s3Key: 'uploads/staging/multipart/stale-expired/payload.bin',
        filename: 'expired.bin',
        mimeType: 'application/octet-stream',
        totalSize: 1024n,
        partSize: 5_242_880,
        totalParts: 1,
        expectedHashHex: null,
        parentId: null,
        status: UploadSessionStatus.FINALIZING,
        finalizingAt: staleTimestamp,
        resultBlobId: null,
        expiresAt: new Date(Date.now() - 60_000),
        createdAt: staleTimestamp,
        updatedAt: staleTimestamp,
      });

      const recovered = await uploadService.recoverStaleFinalizingSessions(10);
      expect(recovered).toBe(2);
      expect(harness.sessions.get('stale-active')?.status).toBe(
        UploadSessionStatus.UPLOADING,
      );
      expect(harness.sessions.get('stale-expired')?.status).toBe(
        UploadSessionStatus.ABORTED,
      );
      expect(driver.abortMultipartUpload).toHaveBeenCalledWith(
        'uploads/staging/multipart/stale-expired/payload.bin',
        'mpu-expired',
      );

      // Seed unpromoted old staging blob and sweep
      const oldCreatedAt = new Date(Date.now() - 10 * 60_000);
      harness.blobs.set('unpromoted-blob-1', {
        id: 'unpromoted-blob-1',
        contentHashHex: 'a'.repeat(64),
        hashAlgorithm: 'SHA256',
        sizeBytes: 2048n,
        mimeType: 'application/pdf',
        checksumVerified: false,
        s3Key: 'uploads/staging/u1/stuck.pdf',
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        refCount: 1,
        status: BlobStatus.READY,
        createdAt: oldCreatedAt,
        tombstoneAt: null,
        claimedAt: null,
      });

      const swept = await uploadService.sweepUnpromotedStagingBlobs(50);
      expect(swept).toBe(1);
      expect(harness.enqueuedJobs).toHaveLength(1);
      expect(harness.enqueuedJobs[0]).toEqual(
        expect.objectContaining({
          name: FILE_JOBS.PROMOTE_CAS,
          data: expect.objectContaining({
            blobId: 'unpromoted-blob-1',
            stagingKey: 'uploads/staging/u1/stuck.pdf',
          }),
        }),
      );
    });

    it('attaches UserRateLimit metadata on FilesController and enforces post-auth per-user burst limits without pre-auth double counting', async () => {
      const reflector = new Reflector();
      const configService = new RateLimitConfigService({
        get: () => undefined,
      } as never);
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
      expect(getRules('batchMultipartPartUrls')).toEqual([
        { bucket: 'files-parts', keyType: 'user' },
      ]);
      expect(getRules('completeMultipart')).toEqual([
        { bucket: 'files-complete', keyType: 'user' },
      ]);
      expect(getRules('streamBlobContent')).toEqual([
        { bucket: 'files-download', keyType: 'user-or-ip' },
      ]);

      // Verify @Public download routes do not duplicate UserRateLimitGuard at handler level
      const publicGuards = Reflect.getMetadata(
        '__guards__',
        FilesController.prototype.streamBlobContent,
      ) as unknown[] | undefined;
      expect(publicGuards ?? []).not.toContain(UserRateLimitGuard);

      const createPresignContext = (userId?: string): ExecutionContext => {
        const res = { header: jest.fn(), setHeader: jest.fn() };
        const req = {
          ip: '10.0.0.5',
          user: userId ? { id: userId } : undefined,
        };
        return {
          switchToHttp: () => ({
            getRequest: () => req,
            getResponse: () => res,
          }),
          getHandler: () => FilesController.prototype.presign,
          getClass: () => FilesController,
        } as unknown as ExecutionContext;
      };

      // Global APP_GUARD pre-auth pass (!req.user) must defer without incrementing bucket
      for (let i = 0; i < 5; i++) {
        await expect(guard.canActivate(createPresignContext())).resolves.toBe(
          true,
        );
      }

      // Post-auth pass allows full 60/min budget and throws 429 on 61st call
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
