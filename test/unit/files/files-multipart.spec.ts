import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import type { FastifyRequest } from 'fastify';
import type { Job, Queue } from 'bullmq';
import {
  FILE_JOBS,
  MIN_MULTIPART_PART_SIZE_BYTES,
  MULTIPART_LARGE_PART_SIZE_BYTES,
  MULTIPART_MEDIUM_PART_SIZE_BYTES,
  STALE_FINALIZING_LEASE_MINUTES,
  STAGING_DELETE_DELAY_MS,
} from '@/modules/files/files.constant';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import { FilesController } from '@/modules/files/controllers/files.controller';
import { LocalFilesController } from '@/modules/files/controllers/local.controller';
import { FilesFacade } from '@/modules/files/files.facade';
import { CasProcessor } from '@/modules/files/processors/cas.processor';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import {
  BlobStatus,
  type StorageBlobRecord,
  type UploadSessionRecord,
  UploadSessionStatus,
} from '@/modules/files/types/files.type';

function createMultipartHarness() {
  const blobs = new Map<string, StorageBlobRecord>();
  const sessions = new Map<string, UploadSessionRecord>();
  const enqueuedJobs: Array<{
    name: string;
    data: unknown;
    opts?: Record<string, unknown>;
  }> = [];
  let usedBytes = 0n;
  let maxBytes = 100n * 1024n * 1024n;

  const blobRepo = fromPartial<BlobRepository>({
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
    incrementRefCount: jest.fn(async (id: string) => {
      const blob = blobs.get(id);
      if (!blob) return null;
      const updated: StorageBlobRecord = {
        ...blob,
        refCount: blob.refCount + 1,
        status: BlobStatus.READY,
      };
      blobs.set(id, updated);
      return updated;
    }),
    hasSpaceAccessToBlob: jest.fn().mockResolvedValue(true),
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
  });

  const quotaRepo = fromPartial<QuotaRepository>({
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
  });

  const sessionRepo = fromPartial<SessionRepository>({
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
    findExpiredSessions: jest.fn(async (limit: number) =>
      Array.from(sessions.values())
        .filter(
          (s) =>
            (s.status === UploadSessionStatus.INITIALIZED ||
              s.status === UploadSessionStatus.UPLOADING) &&
            s.expiresAt.getTime() <= Date.now(),
        )
        .slice(0, limit),
    ),
  });

  const finalizeCasQueue = fromPartial<Queue>({
    add: jest.fn(async (name: string, data: unknown, opts?: Record<string, unknown>) => {
      enqueuedJobs.push({ name, data, opts });
      return fromPartial<Job>({
        id: String(opts?.jobId ?? `${name}-${enqueuedJobs.length}`),
      });
    }),
  });

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

describe('Files Multipart Upload, Local Adapter & Recovery Suite', () => {
  let tempDir: string;
  let localAdapter: LocalStorageAdapter;
  let uploadService: FilesUploadService;
  let controller: FilesController;
  let casProcessor: CasProcessor;
  let harness: ReturnType<typeof createMultipartHarness>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-files-mpu-'));
    localAdapter = new LocalStorageAdapter(tempDir);
    harness = createMultipartHarness();

    const blobService = new BlobService(localAdapter, harness.blobRepo);
    uploadService = new FilesUploadService(
      localAdapter,
      blobService,
      harness.blobRepo,
      harness.quotaRepo,
      harness.sessionRepo,
      harness.finalizeCasQueue,
    );
    casProcessor = new CasProcessor(
      localAdapter,
      blobService,
      harness.blobRepo,
      harness.finalizeCasQueue,
    );
    const facade = new FilesFacade(
      localAdapter,
      blobService,
      harness.blobRepo,
      harness.quotaRepo,
      uploadService,
    );
    controller = new FilesController(facade);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('Multipart lifecycle & CAS promotion', () => {
    it('initiates, signs part URLs, assembles chunks, promotes CAS blob, and cleans staging after delay', async () => {
      const fullPayload = Buffer.from('%PDF-1.7\npart-one-part-two-content');
      const shaHex = crypto
        .createHash('sha256')
        .update(fullPayload)
        .digest('hex');

      const initRes = await controller.initiateMultipart('user-1', {
        filename: 'research-paper.pdf',
        mimeType: 'application/pdf',
        totalSize: fullPayload.length,
      });

      expect(initRes.deduplicated).toBe(false);
      expect(initRes.uploadId).toMatch(/^local-mpu-/);

      const getUrlRes = await controller.getMultipartPartUrl(
        'user-1',
        initRes.sessionId,
        '1',
      );
      expect(getUrlRes.partNumber).toBe(1);
      expect(getUrlRes.uploadUrl).toContain('/api/v1/files/local-upload-part');

      const uploadedPart = await localAdapter.putPart(
        initRes.uploadId,
        1,
        fullPayload,
      );

      const completeRes = await controller.completeMultipart('user-1', {
        sessionId: initRes.sessionId,
        parts: [{ partNumber: 1, eTag: uploadedPart.eTag }],
      });

      expect(completeRes.fileId).toBe(completeRes.blobId);
      expect(completeRes.url).toBe(`/api/v1/files/${completeRes.blobId}/content`);
      expect(completeRes.size).toBe(fullPayload.length);

      const savedSession = harness.sessions.get(initRes.sessionId)!;
      expect(savedSession.status).toBe(UploadSessionStatus.COMPLETED);
      const stagingKey = savedSession.s3Key;

      expect(harness.enqueuedJobs[0]?.name).toBe(FILE_JOBS.PROMOTE_CAS);
      await casProcessor.process(
        fromPartial<Job>({
          id: 'job-promote-1',
          name: FILE_JOBS.PROMOTE_CAS,
          data: harness.enqueuedJobs[0].data,
        }),
      );

      const canonicalKey = `blobs/${shaHex.slice(0, 2)}/${shaHex.slice(2, 4)}/${shaHex}`;
      expect(await localAdapter.exists(canonicalKey)).toBe(true);
      expect(harness.blobs.get(completeRes.blobId)?.s3Key).toBe(canonicalKey);
      expect(harness.blobs.get(completeRes.blobId)?.checksumVerified).toBe(true);

      expect(harness.enqueuedJobs[1]?.name).toBe(FILE_JOBS.DELETE_STAGING);
      expect(harness.enqueuedJobs[1]?.opts?.delay).toBe(STAGING_DELETE_DELAY_MS);

      await casProcessor.process(
        fromPartial<Job>({
          id: 'job-del-1',
          name: FILE_JOBS.DELETE_STAGING,
          data: harness.enqueuedJobs[1].data,
        }),
      );
      expect(await localAdapter.exists(stagingKey)).toBe(false);
    });

    it('short-circuits initiateMultipart via Instant CAS SHA-256 deduplication and increments refCount + quota', async () => {
      const existingBytes = Buffer.from('existing-shared-dataset-bytes');
      const hashHex = ContentHash.fromBuffer(existingBytes).toHex();
      harness.blobs.set('blob-existing-mpu', {
        id: 'blob-existing-mpu',
        contentHashHex: hashHex,
        hashAlgorithm: 'SHA256',
        sizeBytes: BigInt(existingBytes.length),
        mimeType: 'application/octet-stream',
        checksumVerified: true,
        s3Key: StorageKey.forBlob(hashHex).value(),
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        status: BlobStatus.READY,
        refCount: 1,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      });

      const res = await controller.initiateMultipart('user-1', {
        filename: 'dataset.parquet',
        mimeType: 'application/octet-stream',
        totalSize: existingBytes.length,
        expectedHash: hashHex,
      });

      expect(res.deduplicated).toBe(true);
      expect(res.fileId).toBe('blob-existing-mpu');
      expect(harness.blobs.get('blob-existing-mpu')?.refCount).toBe(2);
      expect(harness.getUsedBytes()).toBe(BigInt(existingBytes.length));
      expect(harness.sessions.size).toBe(0);
    });

    it('scales partSize adaptively (5 MB / 16 MB / 64 MB), batch-signs part URLs, and enforces ownership/part validation', async () => {
      harness.setMaxBytes(10n * 1024n * 1024n * 1024n);

      const smallMpu = await controller.initiateMultipart('owner-1', {
        filename: 'small.bin',
        totalSize: 20 * 1024 * 1024,
      });
      expect(smallMpu.partSize).toBe(MIN_MULTIPART_PART_SIZE_BYTES);
      expect(smallMpu.totalParts).toBe(4);

      const mediumMpu = await controller.initiateMultipart('owner-1', {
        filename: 'medium.bin',
        totalSize: 150 * 1024 * 1024,
      });
      expect(mediumMpu.partSize).toBe(MULTIPART_MEDIUM_PART_SIZE_BYTES);

      const largeMpu = await controller.initiateMultipart('owner-1', {
        filename: 'huge.tar.gz',
        totalSize: 2 * 1024 * 1024 * 1024,
      });
      expect(largeMpu.partSize).toBe(MULTIPART_LARGE_PART_SIZE_BYTES);

      const batchRes = await controller.batchMultipartPartUrls(
        'owner-1',
        smallMpu.sessionId,
        { partNumbers: [1, 2, 3, 4] },
      );
      expect(batchRes.parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4]);
      expect(harness.sessions.get(smallMpu.sessionId)?.status).toBe(
        UploadSessionStatus.UPLOADING,
      );

      await expect(
        controller.getMultipartPartUrl('owner-1', smallMpu.sessionId, '0'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.getMultipartPartUrl('owner-1', smallMpu.sessionId, 'abc'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        controller.getMultipartPartUrl('other-user', smallMpu.sessionId, '1'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        controller.abortMultipart('other-user', smallMpu.sessionId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Concurrency, Size-Spoofing Defense & Session Recovery', () => {
    it('allows only one atomic claim across parallel completeMultipart calls and replays idempotently once COMPLETED', async () => {
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
        expect(r.reason).toBeInstanceOf(ConflictException);
        expect(
          ((r.reason as ConflictException).getResponse() as { retryAfter?: number })
            .retryAfter,
        ).toBe(2);
      }
      expect(harness.getUsedBytes()).toBe(BigInt(payload.length));

      const replay = await uploadService.completeMultipart({
        sessionId: init.sessionId,
        parts: [{ partNumber: 1, eTag: part.eTag }],
        actor: { userId: 'user-1' },
      });
      expect(replay.blobId).toBe(fulfilled[0].value.blobId);
      expect(harness.getUsedBytes()).toBe(BigInt(payload.length));
    });

    it('charges actual stat.size instead of spoofed totalSize and cleans up staging when actual size exceeds quota', async () => {
      const actualPayload = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        Buffer.alloc(1024, 0x61),
      ]);
      const initOk = await uploadService.initiateMultipart({
        userId: 'user-1',
        filename: 'spoof.pdf',
        mimeType: 'application/pdf',
        totalSize: 100,
      });
      const partOk = await localAdapter.putPart(
        initOk.uploadId,
        1,
        actualPayload,
      );
      const resOk = await uploadService.completeMultipart({
        sessionId: initOk.sessionId,
        parts: [{ partNumber: 1, eTag: partOk.eTag }],
        actor: { userId: 'user-1' },
      });
      expect(resOk.size).toBe(actualPayload.length);
      expect(harness.blobs.get(resOk.blobId)?.sizeBytes).toBe(
        BigInt(actualPayload.length),
      );

      // Now cap quota so initial 100B passes assertAvailable, but actual 1033B exceeds remaining quota
      harness.setMaxBytes(BigInt(actualPayload.length) + 500n);
      const initOver = await uploadService.initiateMultipart({
        userId: 'user-1',
        filename: 'over-quota-spoof.pdf',
        mimeType: 'application/pdf',
        totalSize: 100,
      });
      const partOver = await localAdapter.putPart(
        initOver.uploadId,
        1,
        actualPayload,
      );

      await expect(
        uploadService.completeMultipart({
          sessionId: initOver.sessionId,
          parts: [{ partNumber: 1, eTag: partOver.eTag }],
          actor: { userId: 'user-1' },
        }),
      ).rejects.toThrow('Storage quota exceeded');

      expect(await localAdapter.exists(initOver.storageKey)).toBe(false);
      expect(harness.sessions.get(initOver.sessionId)?.status).toBe(
        UploadSessionStatus.UPLOADING,
      );
    });

    it('aborts active sessions, cleans expired sessions, recovers stale FINALIZING leases, and sweeps unpromoted staging blobs', async () => {
      const initRes = await controller.initiateMultipart('user-1', {
        filename: 'large-archive.zip',
        mimeType: 'application/zip',
        totalSize: 20 * 1024 * 1024,
      });
      await localAdapter.putPart(
        initRes.uploadId,
        1,
        Buffer.from('partial-chunk-bytes'),
      );
      const stagingDir = path.join(tempDir, '.multipart', initRes.uploadId);
      expect(fs.existsSync(stagingDir)).toBe(true);

      await expect(
        controller.abortMultipart('user-1', initRes.sessionId),
      ).resolves.toEqual({ aborted: true, success: true });
      expect(fs.existsSync(stagingDir)).toBe(false);
      expect(harness.sessions.get(initRes.sessionId)?.status).toBe(
        UploadSessionStatus.ABORTED,
      );

      const staleTimestamp = new Date(
        Date.now() - (STALE_FINALIZING_LEASE_MINUTES + 2) * 60_000,
      );
      harness.sessions.set('expired-init', {
        id: 'expired-init',
        spaceId: 'user-1',
        userId: 'user-1',
        s3UploadId: 'local-mpu-expired-1',
        s3Key: 'uploads/staging/multipart/expired-init/payload.bin',
        filename: 'expired-init.bin',
        mimeType: 'application/octet-stream',
        totalSize: 1024n,
        partSize: 5_242_880,
        totalParts: 1,
        expectedHashHex: null,
        parentId: null,
        status: UploadSessionStatus.INITIALIZED,
        finalizingAt: null,
        resultBlobId: null,
        expiresAt: new Date(Date.now() - 3600_000),
        createdAt: staleTimestamp,
        updatedAt: staleTimestamp,
      });
      expect(await uploadService.cleanupExpiredSessions(50)).toBe(1);
      expect(harness.sessions.get('expired-init')?.status).toBe(
        UploadSessionStatus.ABORTED,
      );

      harness.sessions.set('stale-active', {
        id: 'stale-active',
        spaceId: 'user-1',
        userId: 'user-1',
        s3UploadId: 'local-mpu-stale-active',
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
        s3UploadId: 'local-mpu-stale-expired',
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

      expect(await uploadService.recoverStaleFinalizingSessions(10)).toBe(2);
      expect(harness.sessions.get('stale-active')?.status).toBe(
        UploadSessionStatus.UPLOADING,
      );
      expect(harness.sessions.get('stale-expired')?.status).toBe(
        UploadSessionStatus.ABORTED,
      );

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
        createdAt: new Date(Date.now() - 10 * 60_000),
        tombstoneAt: null,
        claimedAt: null,
      });
      expect(await uploadService.sweepUnpromotedStagingBlobs(50)).toBe(1);
      expect(harness.enqueuedJobs).toContainEqual(
        expect.objectContaining({
          name: FILE_JOBS.PROMOTE_CAS,
          data: expect.objectContaining({
            blobId: 'unpromoted-blob-1',
            stagingKey: 'uploads/staging/u1/stuck.pdf',
          }),
        }),
      );
    });
  });

  describe('LocalStorageAdapter & LocalFilesController Seam', () => {
    it('verifies HMAC tokens, lists sorted staged parts, assembles out-of-order chunks, and enforces SHA-256 on putLocalObject', async () => {
      const resource = 'uploads/staging/user-1/paper.pdf';
      const expiresAt = Date.now() + 60_000;
      const sig = localAdapter.signToken('put', resource, expiresAt);

      expect(localAdapter.verifyToken('put', resource, expiresAt, sig)).toBe(true);
      expect(localAdapter.verifyToken('get', resource, expiresAt, sig)).toBe(false);
      expect(
        localAdapter.verifyToken('put', resource, Date.now() - 1000, sig),
      ).toBe(false);

      const targetKey = 'uploads/staging/multipart/sess-1/payload.bin';
      const { uploadId } = await localAdapter.initiateMultipartUpload(targetKey);
      expect(await localAdapter.listUploadedParts(targetKey, uploadId)).toEqual([]);

      const res2 = await localAdapter.putPart(
        uploadId,
        2,
        Readable.from([Buffer.from('World!')]),
      );
      const res1 = await localAdapter.putPart(uploadId, 1, Buffer.from('Hello '));

      expect(await localAdapter.listUploadedParts(targetKey, uploadId)).toEqual([
        { partNumber: 1, eTag: res1.eTag },
        { partNumber: 2, eTag: res2.eTag },
      ]);

      await localAdapter.completeMultipartUpload(targetKey, uploadId, [
        { partNumber: 2, eTag: res2.eTag },
        { partNumber: 1, eTag: res1.eTag },
      ]);
      const assembled = await fs.promises.readFile(
        localAdapter.resolveFilePath(targetKey),
        'utf8',
      );
      expect(assembled).toBe('Hello World!');

      const localController = new LocalFilesController(localAdapter);
      const payload = Buffer.from('%PDF-1.7 verified local put payload');
      const sha256Base64 = crypto
        .createHash('sha256')
        .update(payload)
        .digest('base64');

      const signedUrl = await localAdapter.getPresignedUploadUrl(
        'uploads/staging/u1/verified.pdf',
        {
          mimeType: 'application/pdf',
          checksumSha256Base64: sha256Base64,
        },
      );
      const parsed = new URL(signedUrl, 'http://localhost');
      const key = parsed.searchParams.get('key')!;
      const exp = parsed.searchParams.get('expires')!;
      const putSig = parsed.searchParams.get('sig')!;
      const shaParam = parsed.searchParams.get('sha256')!;

      await expect(
        localController.putLocalObject(
          key,
          exp,
          putSig,
          shaParam,
          fromPartial<FastifyRequest>({ body: Buffer.from('TAMPERED') }),
        ),
      ).rejects.toThrow('Content hash mismatch');
      expect(await localAdapter.exists(key)).toBe(false);

      await expect(
        localController.putLocalObject(
          key,
          exp,
          putSig,
          shaParam,
          fromPartial<FastifyRequest>({ body: payload }),
        ),
      ).resolves.toEqual({ ok: true });
      expect(await localAdapter.exists(key)).toBe(true);
    });
  });
});
