import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  BlobStatus,
  DEFAULT_STORAGE_QUOTA_BYTES,
  StorageBlobRecord,
  StorageQuotaRecord,
  UploadSessionRecord,
  UploadSessionStatus,
} from '@/modules/files';
import {
  MIN_MULTIPART_PART_SIZE_BYTES,
  MULTIPART_LARGE_PART_SIZE_BYTES,
  MULTIPART_MEDIUM_PART_SIZE_BYTES,
} from '@/modules/files/files.constant';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage-vo';
import { FilesFacade } from '@/modules/files/files.facade';
import { FilesController } from '@/modules/files/controllers/files.controller';
import { LocalFilesController } from '@/modules/files/controllers/local.controller';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';

function createInMemoryRepos() {
  const blobs = new Map<string, StorageBlobRecord>();
  const sessions = new Map<string, UploadSessionRecord>();

  const blobRepo = {
    findById: jest.fn(async (id: string) => blobs.get(id) ?? null),
    findByHash: jest.fn(async (hex: string) => {
      for (const blob of blobs.values()) {
        if (blob.contentHashHex === hex) return blob;
      }
      return null;
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
    delete: jest.fn(async (id: string) => {
      blobs.delete(id);
    }),
    deleteMany: jest.fn().mockResolvedValue(undefined),
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
    decrementRefCount: jest.fn().mockResolvedValue(null),
    reclaimStuckClaims: jest.fn().mockResolvedValue(0),
    claimOrphanBlobsBatch: jest.fn().mockResolvedValue([]),
    restoreClaimedBlob: jest.fn().mockResolvedValue(undefined),
    hasSpaceAccessToBlob: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<BlobRepository>;

  let usedBytes = 0n;
  const maxBytes = BigInt(100 * 1024 * 1024);
  const findBySpaceId = jest.fn(
    async (spaceId?: string | null): Promise<StorageQuotaRecord | null> => ({
      spaceId: spaceId ?? 'user-1',
      usedBytes,
      maxBytes,
      updatedAt: new Date(),
    }),
  );
  const quotaRepo = {
    findBySpaceId,
    assertAvailable: jest.fn(async (spaceId, requiredBytes: bigint) => {
      const q = spaceId ? await findBySpaceId(spaceId) : null;
      const max = q ? q.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
      const used = q ? q.usedBytes : 0n;
      if (used + requiredBytes > max) {
        throw new BadRequestException('Storage quota exceeded');
      }
    }),
    incrementUsage: jest.fn(async (_spaceId, bytes: bigint) => {
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
    findExpiredSessions: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<SessionRepository>;

  return { blobs, sessions, blobRepo, quotaRepo, sessionRepo };
}

describe('FilesController Multipart Endpoints', () => {
  let tempDir: string;
  let localAdapter: LocalStorageAdapter;
  let controller: FilesController;
  let repos: ReturnType<typeof createInMemoryRepos>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-files-mpu-'));
    localAdapter = new LocalStorageAdapter(tempDir);
    repos = createInMemoryRepos();

    const blobService = new BlobService(localAdapter, repos.blobRepo);
    const uploadService = new FilesUploadService(
      localAdapter,
      blobService,
      repos.blobRepo,
      repos.quotaRepo,
      repos.sessionRepo,
    );
    const facade = new FilesFacade(
      localAdapter,
      blobService,
      repos.blobRepo,
      repos.quotaRepo,
      uploadService,
    );

    controller = new FilesController(facade);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('initiates, signs part URLs, assembles chunks, and promotes CAS blob', async () => {
    const part1 = Buffer.from('%PDF-1.7\npart-one-');
    const part2 = Buffer.from('part-two-content');
    const fullPayload = Buffer.concat([part1, part2]);
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
    expect(initRes.sessionId).toBeTruthy();
    expect(initRes.uploadId).toMatch(/^local-mpu-/);
    expect(initRes.totalParts).toBe(1);

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

    expect(completeRes.blobId).toBeTruthy();
    expect(completeRes.fileId).toBe(completeRes.blobId);
    expect(completeRes.url).toBe(`/api/v1/files/${completeRes.blobId}/content`);
    expect(completeRes.filename).toBe('research-paper.pdf');
    expect(completeRes.size).toBe(fullPayload.length);

    const canonicalKey = `blobs/${shaHex.slice(0, 2)}/${shaHex.slice(2, 4)}/${shaHex}`;
    expect(await localAdapter.exists(canonicalKey)).toBe(true);

    const savedSession = repos.sessions.get(initRes.sessionId);
    expect(savedSession?.status).toBe(UploadSessionStatus.COMPLETED);
  });

  it('short-circuits initiateMultipart via Instant CAS SHA-256 deduplication', async () => {
    const existingBytes = Buffer.from('existing-shared-dataset-bytes');
    const hashHex = ContentHash.fromBuffer(existingBytes).toHex();
    const existingBlob: StorageBlobRecord = {
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
    };
    repos.blobs.set(existingBlob.id, existingBlob);

    const res = await controller.initiateMultipart('user-1', {
      filename: 'dataset.parquet',
      mimeType: 'application/octet-stream',
      totalSize: existingBytes.length,
      expectedHash: hashHex,
    });

    expect(res.deduplicated).toBe(true);
    expect(res.fileId).toBe(existingBlob.id);
    expect(res.url).toBe(`/api/v1/files/${existingBlob.id}/content`);
    expect(repos.blobs.get(existingBlob.id)?.refCount).toBe(2);
  });

  it('rejects invalid part numbers and enforces session user ownership', async () => {
    const initRes = await controller.initiateMultipart('owner-1', {
      filename: 'data.bin',
      mimeType: 'application/octet-stream',
      totalSize: 1024,
    });

    await expect(
      controller.getMultipartPartUrl('owner-1', initRes.sessionId, '0'),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.getMultipartPartUrl('owner-1', initRes.sessionId, 'abc'),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.getMultipartPartUrl('other-user', initRes.sessionId, '1'),
    ).rejects.toThrow(NotFoundException);

    await expect(
      controller.abortMultipart('other-user', initRes.sessionId),
    ).rejects.toThrow(NotFoundException);
  });

  it('aborts session on DELETE multipart/:sessionId and cleans up temporary chunk files', async () => {
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

    const abortRes = await controller.abortMultipart(
      'user-1',
      initRes.sessionId,
    );
    expect(abortRes).toEqual({ aborted: true, success: true });
    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(repos.sessions.get(initRes.sessionId)?.status).toBe(
      UploadSessionStatus.ABORTED,
    );
  });

  it('batch-signs part URLs in 1 call and transitions session status in DB only once', async () => {
    const initRes = await controller.initiateMultipart('user-1', {
      filename: 'multi-batch.tar',
      mimeType: 'application/x-tar',
      totalSize: 20 * 1024 * 1024,
    });
    expect(initRes.totalParts).toBe(4);

    const batchRes = await controller.batchMultipartPartUrls(
      'user-1',
      initRes.sessionId,
      { partNumbers: [1, 2, 3, 4] },
    );

    expect(batchRes.parts).toHaveLength(4);
    expect(batchRes.parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4]);
    expect(batchRes.parts[0].uploadUrl).toContain(
      '/api/v1/files/local-upload-part',
    );
    expect(repos.sessionRepo.markUploadingIfInitialized).toHaveBeenCalledTimes(
      1,
    );

    await controller.getMultipartPartUrl('user-1', initRes.sessionId, '2');
    expect(repos.sessionRepo.markUploadingIfInitialized).toHaveBeenCalledTimes(
      1,
    );
  });

  it('scales multipart partSize adaptively (5 MB / 16 MB / 64 MB) by total upload size', async () => {
    const smallMpu = await controller.initiateMultipart('user-1', {
      filename: 'small.bin',
      totalSize: 20 * 1024 * 1024,
    });
    expect(smallMpu.partSize).toBe(MIN_MULTIPART_PART_SIZE_BYTES);

    repos.quotaRepo.findBySpaceId.mockResolvedValueOnce({
      spaceId: 'user-1',
      usedBytes: 0n,
      maxBytes: 10n * 1024n * 1024n * 1024n,
      updatedAt: new Date(),
    });
    const mediumMpu = await controller.initiateMultipart('user-1', {
      filename: 'medium.bin',
      totalSize: 150 * 1024 * 1024,
    });
    expect(mediumMpu.partSize).toBe(MULTIPART_MEDIUM_PART_SIZE_BYTES);

    repos.quotaRepo.findBySpaceId.mockResolvedValueOnce({
      spaceId: 'user-1',
      usedBytes: 0n,
      maxBytes: 10n * 1024n * 1024n * 1024n,
      updatedAt: new Date(),
    });
    const largeMpu = await controller.initiateMultipart('user-1', {
      filename: 'huge-dataset.tar.gz',
      totalSize: 2 * 1024 * 1024 * 1024,
    });
    expect(largeMpu.partSize).toBe(MULTIPART_LARGE_PART_SIZE_BYTES);
  });

  it('enforces HMAC-bound sha256 verification on LocalFilesController.putLocalObject', async () => {
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
    const expires = parsed.searchParams.get('expires')!;
    const sig = parsed.searchParams.get('sig')!;
    const shaParam = parsed.searchParams.get('sha256')!;

    await expect(
      localController.putLocalObject(key, expires, sig, shaParam, {
        body: Buffer.from('TAMPERED_PAYLOAD'),
      } as any),
    ).rejects.toThrow('Content hash mismatch');
    expect(await localAdapter.exists(key)).toBe(false);

    const okRes = await localController.putLocalObject(
      key,
      expires,
      sig,
      shaParam,
      { body: payload } as any,
    );
    expect(okRes).toEqual({ ok: true });
    expect(await localAdapter.exists(key)).toBe(true);
  });
});
