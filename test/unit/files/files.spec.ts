import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { BlobStatus, StorageBlobRecord, StorageQuotaRecord } from '@/modules/files/types/files.type';
import { DEFAULT_STORAGE_QUOTA_BYTES } from '@/modules/files/files.constant';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
import { FilesFacade } from '@/modules/files/files.facade';
import { FilesController } from '@/modules/files/controllers/files.controller';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import { S3StorageAdapter } from '@/modules/files/adapters/s3.adapter';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { FileAccessService } from '@/modules/files/services/access.service';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';

function createMockAdapter(): jest.Mocked<IStorageAdapter> {
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
    initiateMultipartUpload: jest
      .fn()
      .mockResolvedValue({ uploadId: 'mpu-upload-id' }),
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
    hasUserAccessToSpace: jest.fn().mockResolvedValue(true),
    hasUserAccessToBlob: jest.fn().mockResolvedValue(true),
    attachRef: jest.fn(),
    detachRef: jest.fn(),
    existsInSpace: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<BlobRepository>;
}

function createMockQuotaRepo(
  quota: StorageQuotaRecord | null = null,
): jest.Mocked<QuotaRepository> {
  return {
    findBySpaceId: jest.fn().mockResolvedValue(quota),
    assertAvailable: jest.fn(async (_spaceId, requiredBytes: bigint) => {
      const current = quota ?? null;
      const maxBytes = current ? current.maxBytes : DEFAULT_STORAGE_QUOTA_BYTES;
      const usedBytes = current ? current.usedBytes : 0n;
      if (usedBytes + requiredBytes > maxBytes) {
        throw new BadRequestException('Storage quota exceeded');
      }
    }),
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

describe('FilesModule Standalone Capabilities & Hardening', () => {
  describe('BlobService Atomic CAS GC (reclaimOrphanBlobs)', () => {
    it('deletes physical object and DB record when claimOrphanBlobsBatch claims candidate', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hashHex = ContentHash.fromBuffer(
        Buffer.from('dead-orphan'),
      ).toHex();
      const orphan = makeBlobRecord({
        id: 'blob-dead-1',
        contentHashHex: hashHex,
        sizeBytes: 256n,
        status: BlobStatus.DELETED,
        refCount: 0,
      });

      blobRepo.claimOrphanBlobsBatch.mockResolvedValueOnce([orphan]);

      const service = new BlobService(adapter, blobRepo);
      const count = await service.reclaimOrphanBlobs(10);

      expect(count).toBe(1);
      expect(adapter.delete).toHaveBeenCalledWith(orphan.s3Key);
      expect(blobRepo.delete).toHaveBeenCalledWith('blob-dead-1');
      expect(blobRepo.restoreClaimedBlob).not.toHaveBeenCalled();
    });

    it('restores claimed blob and skips DB hard delete if adapter.delete throws', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hashHex = ContentHash.fromBuffer(
        Buffer.from('s3-error-orphan'),
      ).toHex();
      const orphan = makeBlobRecord({
        id: 'blob-err-1',
        contentHashHex: hashHex,
        sizeBytes: 512n,
        status: BlobStatus.DELETED,
        refCount: 0,
      });

      blobRepo.claimOrphanBlobsBatch.mockResolvedValueOnce([orphan]);
      adapter.delete.mockRejectedValue(new Error('S3 network timeout'));

      const service = new BlobService(adapter, blobRepo);
      const count = await service.reclaimOrphanBlobs(10);

      expect(count).toBe(0);
      expect(blobRepo.restoreClaimedBlob).toHaveBeenCalledWith('blob-err-1');
      expect(blobRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('BlobService Canonical CAS Promotion', () => {
    it('promotes staging key to blobs/<p1>/<p2>/<sha256> via adapter.copy and deletes staging key', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const service = new BlobService(adapter, blobRepo);

      const payload = Buffer.from('%PDF-1.7 canonical promotion payload');
      const shaHex = crypto.createHash('sha256').update(payload).digest('hex');
      const stagingKey = 'uploads/staging/u1/file.pdf';
      const canonicalKey = `blobs/${shaHex.slice(0, 2)}/${shaHex.slice(2, 4)}/${shaHex}`;

      const result = await service.registerUploadedObject({
        storageKey: stagingKey,
        sizeBytes: BigInt(payload.length),
        contentHashHex: shaHex,
      });

      expect(result.isDeduplicated).toBe(false);
      expect(adapter.copy).toHaveBeenCalledWith(stagingKey, canonicalKey);
      expect(adapter.delete).toHaveBeenCalledWith(stagingKey);
      expect(result.blob.s3Key).toBe(canonicalKey);
      expect(blobRepo.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('LocalStorageAdapter HMAC Signing & Disk Multipart Assembly', () => {
    let tempDir: string;
    let localAdapter: LocalStorageAdapter;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flux-files-module-'));
      localAdapter = new LocalStorageAdapter(tempDir);
    });

    afterEach(async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it('verifies valid HMAC tokens and rejects expired or tampered tokens', () => {
      const resource = 'uploads/staging/user-1/paper.pdf';
      const expiresAt = Date.now() + 60_000;
      const sig = localAdapter.signToken('put', resource, expiresAt);

      expect(localAdapter.verifyToken('put', resource, expiresAt, sig)).toBe(
        true,
      );
      expect(localAdapter.verifyToken('get', resource, expiresAt, sig)).toBe(
        false,
      );
      expect(
        localAdapter.verifyToken(
          'put',
          'uploads/staging/user-1/other.pdf',
          expiresAt,
          sig,
        ),
      ).toBe(false);
      expect(
        localAdapter.verifyToken('put', resource, Date.now() - 1000, sig),
      ).toBe(false);
    });

    it('assembles disk multipart chunks in partNumber order and cleans up staging chunks', async () => {
      const targetKey = 'uploads/staging/multipart/sess-1/payload.bin';
      const { uploadId } =
        await localAdapter.initiateMultipartUpload(targetKey);

      const part1Data = Buffer.from('Hello ');
      const part2Data = Readable.from([Buffer.from('World!')]);

      const res2 = await localAdapter.putPart(uploadId, 2, part2Data);
      const res1 = await localAdapter.putPart(uploadId, 1, part1Data);

      expect(res1.eTag).toMatch(/^[a-f0-9]{32}$/);
      expect(res2.eTag).toMatch(/^[a-f0-9]{32}$/);

      await localAdapter.completeMultipartUpload(targetKey, uploadId, [
        { partNumber: 2, eTag: res2.eTag },
        { partNumber: 1, eTag: res1.eTag },
      ]);

      const assembledPath = localAdapter.resolveFilePath(targetKey);
      const content = await fs.promises.readFile(assembledPath, 'utf8');
      expect(content).toBe('Hello World!');

      const stagingDir = path.join(tempDir, '.multipart', uploadId);
      expect(fs.existsSync(stagingDir)).toBe(false);
    });
  });

  describe('QuotaRepository & StorageNode-Free FilesUploadService / FilesFacade', () => {
    it('enforces quota limit on assertAvailable, delegates increment/decrement, and reconciles without soft-deleted or double-counted refs', async () => {
      const userId = '11111111-1111-4111-8111-111111111111';
      const executeRaw = jest.fn().mockResolvedValue(2);
      const mockPrisma = {
        spaceQuota: {
          findUnique: jest.fn().mockResolvedValue({
            spaceId: userId,
            usedBytes: 900n,
            maxBytes: 1000n,
            updatedAt: new Date(),
          }),
        },
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ used_bytes: 950n }])
          .mockResolvedValueOnce([{ used_bytes: 900n }]),
        $executeRaw: executeRaw,
      };
      const quotaRepo = new QuotaRepository(mockPrisma as never);

      await expect(
        quotaRepo.assertAvailable(userId, 50n),
      ).resolves.toBeUndefined();
      await expect(quotaRepo.assertAvailable(userId, 200n)).rejects.toThrow(
        'Storage quota exceeded',
      );

      expect(await quotaRepo.incrementUsage(userId, 50n)).toBe(950n);
      expect(await quotaRepo.decrementUsage(userId, 50n)).toBe(900n);

      expect(await quotaRepo.reconcileSpaceQuotas(100)).toBe(2);
      const sqlStrings = (executeRaw.mock.calls[0]?.[0] as string[]).join(' ');
      expect(sqlStrings).toContain('att.deleted_at IS NULL');
      expect(sqlStrings).toContain('li.deleted_at IS NULL');
      expect(sqlStrings).toContain(
        "r.owner_type NOT IN ('storage_file', 'page_file', 'attachment')",
      );
    });

    it('short-circuits initiateMultipart via Instant CAS Deduplication without creating session', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);

      const hashHex = ContentHash.fromBuffer(
        Buffer.from('existing-dataset'),
      ).toHex();
      const existingBlob = makeBlobRecord({
        id: 'blob-existing-1',
        contentHashHex: hashHex,
        sizeBytes: 10_000_000n,
      });

      blobRepo.findByHash.mockResolvedValue(existingBlob);
      blobRepo.incrementRefCount.mockResolvedValue({
        ...existingBlob,
        refCount: 2,
      });

      const sessionRepo = createMockSessionRepo();
      const quotaRepo = createMockQuotaRepo({
        spaceId: 'user-1',
        usedBytes: 0n,
        maxBytes: 500_000_000n,
        updatedAt: new Date(),
      });
      quotaRepo.incrementUsage.mockResolvedValue(10_000_000n);

      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        sessionRepo,
      );
      const facade = new FilesFacade(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        uploadService,
      );

      const res = await facade.initiateMultipart({
        userId: 'user-1',
        filename: 'large-dataset.parquet',
        mimeType: 'application/octet-stream',
        totalSize: 10_000_000,
        expectedHash: hashHex,
      });

      expect(res.deduplicated).toBe(true);
      expect(res.blob?.id).toBe(existingBlob.id);
      expect(adapter.initiateMultipartUpload).not.toHaveBeenCalled();
      expect(sessionRepo.create).not.toHaveBeenCalled();
      expect(blobRepo.incrementRefCount).toHaveBeenCalledWith(existingBlob.id);
      expect(quotaRepo.incrementUsage).toHaveBeenCalledWith(
        'user-1',
        existingBlob.sizeBytes,
      );
    });

    it('deletes orphaned staging object when completePresignedUpload quota reserve rejects', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);

      const stagingKey = 'uploads/staging/user-1/over-quota.txt';
      adapter.stat.mockResolvedValue({
        key: stagingKey,
        size: 1024,
        mimeType: 'text/plain',
        lastModified: new Date(),
      });
      adapter.getStream.mockResolvedValue({
        stream: Readable.from([Buffer.from('plain text payload')]),
        contentLength: 18,
      });

      const quotaRepo = createMockQuotaRepo();
      quotaRepo.incrementUsage.mockRejectedValue(
        new BadRequestException('Storage quota exceeded'),
      );

      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
      );

      await expect(
        uploadService.completePresignedUpload({
          userId: 'user-1',
          storageKey: stagingKey,
          filename: 'over-quota.txt',
          mimeType: 'text/plain',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow('Storage quota exceeded');

      expect(adapter.delete).toHaveBeenCalledWith(stagingKey);
    });

    it('uploads, reads, and streams PNG content via FilesFacade & FilesController without StorageNode (and queries findById once in getOwnedFileStream)', async () => {
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
      ]);

      const storedBlobs = new Map<string, StorageBlobRecord>();
      const storedObjects = new Map<string, Buffer>();

      const adapter: jest.Mocked<IStorageAdapter> = {
        ...createMockAdapter(),
        put: jest.fn(async (key, data) => {
          storedObjects.set(
            key,
            Buffer.isBuffer(data) ? data : Buffer.alloc(0),
          );
        }),
        getStream: jest.fn(async (key, range) => {
          const buf = storedObjects.get(key) || Buffer.alloc(0);
          if (range) {
            const slice = buf.subarray(range.start, range.end + 1);
            return {
              stream: Readable.from([slice]),
              contentLength: slice.length,
              contentRange: `bytes ${range.start}-${range.end}/${buf.length}`,
            };
          }
          return { stream: Readable.from([buf]), contentLength: buf.length };
        }),
        stat: jest.fn(async (key) => ({
          key,
          size: (storedObjects.get(key) || Buffer.alloc(0)).length,
          mimeType: 'application/octet-stream',
          lastModified: new Date(),
        })),
      };

      const blobRepo = createMockBlobRepo();
      blobRepo.create.mockImplementation(async (input) => {
        const record = makeBlobRecord({
          id: input.id,
          contentHashHex: input.contentHashHex,
          sizeBytes: input.sizeBytes,
          mimeType: input.mimeType,
          checksumVerified: input.checksumVerified,
          s3Key: input.s3Key,
          s3Bucket: input.s3Bucket,
        });
        storedBlobs.set(record.id, record);
        return record;
      });
      blobRepo.findById.mockImplementation(
        async (id) => storedBlobs.get(id) ?? null,
      );

      const blobService = new BlobService(adapter, blobRepo);
      const quotaRepo = createMockQuotaRepo({
        spaceId: 'user-1',
        usedBytes: 0n,
        maxBytes: 1_000_000n,
        updatedAt: new Date(),
      });
      quotaRepo.incrementUsage.mockResolvedValue(BigInt(pngBytes.length));

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

      const uploaded = await facade.uploadFile({
        userId: 'user-1',
        filename: 'avatar.png',
        buffer: pngBytes,
        mimeType: 'image/png',
      });

      expect(uploaded.fileId).toBe(uploaded.blobId);
      expect(uploaded.url).toBe(`/api/v1/files/${uploaded.blobId}/content`);

      const readRes = await facade.readOwnedFile({
        fileId: uploaded.fileId,
        userId: 'user-1',
      });
      expect(readRes.mimeType).toBe('image/png');
      expect(readRes.buffer).toEqual(pngBytes);

      blobRepo.findById.mockClear();
      await facade.getOwnedFileStream({
        fileId: uploaded.fileId,
        userId: 'user-1',
      });
      expect(blobRepo.findById).toHaveBeenCalledTimes(1);

      const controller = new FilesController(facade);
      const headers = new Map<string, string | number>();
      let statusCode = 0;
      let sentBody: unknown;
      const mockReply = {
        status: jest.fn((code: number) => {
          statusCode = code;
          return mockReply;
        }),
        header: jest.fn((k: string, v: string | number) => {
          headers.set(k.toLowerCase(), v);
          return mockReply;
        }),
        send: jest.fn((body: unknown) => {
          sentBody = body;
          return mockReply;
        }),
      } as any;

      await controller.streamBlobContent(
        uploaded.blobId,
        'avatar.png',
        undefined,
        { url: uploaded.url, headers: {}, user: { id: 'user-1' } } as any,
        mockReply,
      );

      expect(statusCode).toBe(200);
      expect(headers.get('content-type')).toBe('image/png');
      expect(headers.get('content-disposition')).toContain('inline');
      expect(headers.get('cache-control')).toBe(
        'private, max-age=31536000, immutable',
      );
      expect(sentBody).toBeDefined();
    });

    it('uses spaceId-first quota attribution for uploadFile and releases space quota on deleteFile', async () => {
      const targetSpaceId = '22222222-2222-4222-8222-222222222222';
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const storedBlobs = new Map<string, StorageBlobRecord>();
      blobRepo.create.mockImplementation(async (input) => {
        const record = makeBlobRecord({
          id: input.id,
          contentHashHex: input.contentHashHex,
          sizeBytes: input.sizeBytes,
          mimeType: input.mimeType,
          checksumVerified: input.checksumVerified,
          s3Key: input.s3Key,
          s3Bucket: input.s3Bucket,
        });
        storedBlobs.set(record.id, record);
        return record;
      });
      blobRepo.findById.mockImplementation(
        async (id) => storedBlobs.get(id) ?? null,
      );
      const blobService = new BlobService(adapter, blobRepo);

      const quotaRepo = createMockQuotaRepo({
        spaceId: targetSpaceId,
        usedBytes: 0n,
        maxBytes: 1_000_000n,
        updatedAt: new Date(),
      });
      quotaRepo.incrementUsage.mockResolvedValue(22n);

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

      const pdfBytes = Buffer.from('%PDF-1.7\nhello space!');
      const uploaded = await facade.uploadFile({
        userId: 'system',
        spaceId: targetSpaceId,
        filename: 'fulltext.json.gz',
        buffer: pdfBytes,
        mimeType: 'application/gzip',
      });

      expect(quotaRepo.assertAvailable).toHaveBeenCalledWith(
        targetSpaceId,
        BigInt(pdfBytes.length),
      );
      expect(quotaRepo.incrementUsage).toHaveBeenCalledWith(
        targetSpaceId,
        BigInt(pdfBytes.length),
      );

      await facade.deleteFile(uploaded.fileId, { spaceId: targetSpaceId });

      expect(quotaRepo.decrementUsage).toHaveBeenCalledWith(
        targetSpaceId,
        BigInt(pdfBytes.length),
      );
      expect(blobRepo.decrementRefCount).toHaveBeenCalledWith(uploaded.fileId);
    });

    it('blocks path traversal and restricted prefixes (including blobs/*) on FilesController.streamObjectByKey', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const quotaRepo = createMockQuotaRepo();
      const blobService = new BlobService(adapter, blobRepo);
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
      const streamByKeySpy = jest.spyOn(facade, 'streamByKey');
      const controller = new FilesController(facade);

      for (const blockedUrl of [
        '/api/v1/files/objects/..%2F..%2Fetc%2Fpasswd',
        '/api/v1/files/objects/backups%2Fproject-backup.zip',
        '/api/v1/files/objects/uploads%2Fstaging%2Fsecret.bin',
        '/api/v1/files/objects/blobs%2Fe3%2Fb0%2Fsecret-hash',
      ]) {
        let statusCode = 0;
        let payload: unknown;
        const mockRes = {
          status: jest.fn((code: number) => {
            statusCode = code;
            return mockRes;
          }),
          header: jest.fn().mockReturnThis(),
          send: jest.fn((body: unknown) => {
            payload = body;
            return mockRes;
          }),
        } as any;

        await controller.streamObjectByKey(
          { url: blockedUrl, headers: {} } as any,
          mockRes,
        );

        expect(statusCode).toBe(403);
        expect(payload).toEqual(
          expect.objectContaining({
            statusCode: 403,
            message: 'Access to restricted storage path is forbidden',
          }),
        );
      }
      expect(streamByKeySpy).not.toHaveBeenCalled();
    });
  });

  describe('P0–P3 Data-Loss, CAS Integrity, AuthZ/BOLA, Delivery & BlobRef Hardening', () => {
    it('promotes >100MB unhashed uploads out of uploads/staging/ to blobs/raw/ to prevent 24h lifecycle deletion', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const service = new BlobService(adapter, blobRepo);

      const stagingKey = 'uploads/staging/multipart/sess-150mb/payload.bin';
      const result = await service.registerUploadedObject({
        storageKey: stagingKey,
        sizeBytes: 150n * 1024n * 1024n,
        contentHashHex: 'a'.repeat(64),
        mimeType: 'application/zip',
        checksumVerified: false,
      });

      expect(result.isDeduplicated).toBe(false);
      expect(result.blob.checksumVerified).toBe(false);
      expect(result.blob.s3Key).toMatch(/^blobs\/raw\/[a-z0-9]{2}\//);
      expect(result.blob.s3Key).not.toContain('uploads/staging/');
      expect(adapter.copy).toHaveBeenCalledWith(stagingKey, result.blob.s3Key);
      expect(adapter.delete).toHaveBeenCalledWith(stagingKey);
    });

    it('rejects CAS poisoning when uploaded stream SHA-256 differs from declared contentHash and deletes staging object', async () => {
      const adapter = createMockAdapter();
      const actualBytes = Buffer.from('%PDF-1.7 actual payload bytes');
      adapter.getStream.mockResolvedValue({
        stream: Readable.from([actualBytes]),
        contentLength: actualBytes.length,
      });
      const blobRepo = createMockBlobRepo();
      const service = new BlobService(adapter, blobRepo);

      const stagingKey = 'uploads/staging/attacker/poison.pdf';
      await expect(
        service.registerUploadedObject({
          storageKey: stagingKey,
          sizeBytes: BigInt(actualBytes.length),
          contentHashHex: 'f'.repeat(64),
          mimeType: 'application/pdf',
        }),
      ).rejects.toThrow('Content hash mismatch');

      expect(adapter.delete).toHaveBeenCalledWith(stagingKey);
      expect(blobRepo.create).not.toHaveBeenCalled();
    });

    it('binds x-amz-checksum-sha256 in S3StorageAdapter presigned PUT URLs and enables checksum mode in stat()', async () => {
      const s3 = new S3StorageAdapter({
        endpoint: 'https://acc123.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'flux',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        },
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

      const mockSend = jest.fn().mockResolvedValue({
        ContentLength: 1234,
        ContentType: 'application/pdf',
        ChecksumSHA256: sha256Base64,
        LastModified: new Date(),
      });
      (s3 as unknown as { client: { send: jest.Mock } }).client = {
        send: mockSend,
      };
      const meta = await s3.stat('uploads/staging/u1/paper.pdf');
      expect(meta.checksumSha256).toBe(sha256Base64);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('denies cross-space Instant CAS Dedup on presignUpload and initiateMultipart (prevents Hash Oracle)', async () => {
      const adapter = createMockAdapter();
      const payloadHashHex = ContentHash.fromBuffer(
        Buffer.from('tenant-secret'),
      ).toHex();
      const existingBlob = makeBlobRecord({
        id: 'blob-tenant-a',
        contentHashHex: payloadHashHex,
        sizeBytes: 4096n,
      });

      const blobRepo = createMockBlobRepo();
      blobRepo.findByHash.mockResolvedValue(existingBlob);
      blobRepo.hasSpaceAccessToBlob.mockResolvedValue(false);

      const quotaRepo = createMockQuotaRepo();
      const sessionRepo = createMockSessionRepo();
      const uploadService = new FilesUploadService(
        adapter,
        new BlobService(adapter, blobRepo),
        blobRepo,
        quotaRepo,
        sessionRepo,
      );

      const presignRes = await uploadService.presignUpload({
        userId: 'attacker-user',
        spaceId: 'tenant-b-space',
        filename: 'probe.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4096,
        contentHash: payloadHashHex,
      });
      expect(presignRes.deduplicated).toBe(false);
      expect(presignRes.uploadUrl).toBe('https://signed/put');

      const mpuRes = await uploadService.initiateMultipart({
        userId: 'attacker-user',
        spaceId: 'tenant-b-space',
        filename: 'probe.bin',
        mimeType: 'application/octet-stream',
        totalSize: 20_000_000,
        expectedHash: payloadHashHex,
      });
      expect(mpuRes.deduplicated).toBe(false);
      expect(mpuRes.sessionId).toBeTruthy();
      expect(sessionRepo.create).toHaveBeenCalledTimes(1);
    });

    it('enforces auth/signed HMAC on derivative objects while allowing allowlisted public assets', async () => {
      const adapter = createMockAdapter();
      adapter.getStream.mockResolvedValue({
        stream: Readable.from([Buffer.from('webp-bytes')]),
        contentLength: 10,
      });
      const blobRepo = createMockBlobRepo();
      const quotaRepo = createMockQuotaRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
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
      const derivKey = `derivatives/aa/aa/${'a'.repeat(64)}/thumb.webp`;
      const controller = new FilesController(facade);

      const makeMockRes = () => {
        const state = { status: 0, body: undefined as unknown };
        const res: any = {
          status: jest.fn((c: number) => {
            state.status = c;
            return res;
          }),
          header: jest.fn().mockReturnThis(),
          send: jest.fn((b: unknown) => {
            state.body = b;
            return res;
          }),
        };
        return { res, state };
      };

      const anonDeriv = makeMockRes();
      await controller.streamObjectByKey(
        {
          url: `/api/v1/files/objects/${encodeURIComponent(derivKey)}`,
          headers: {},
          query: {},
        } as any,
        anonDeriv.res,
      );
      expect(anonDeriv.state.status).toBe(401);

      const signedPath = accessService.signObjectUrl(derivKey, 300);
      const parsedSigned = new URL(signedPath, 'http://localhost');
      const signedDeriv = makeMockRes();
      await controller.streamObjectByKey(
        {
          url: signedPath,
          headers: {},
          query: {
            exp: parsedSigned.searchParams.get('exp'),
            sig: parsedSigned.searchParams.get('sig'),
          },
        } as any,
        signedDeriv.res,
      );
      expect(signedDeriv.state.status).toBe(200);

      const pubRes = makeMockRes();
      await controller.streamObjectByKey(
        {
          url: '/api/v1/files/objects/public%2Favatars%2Favatar-1.png',
          headers: {},
          query: {},
        } as any,
        pubRes.res,
      );
      expect(pubRes.state.status).toBe(200);
    });

    it('hardens :blobId/content and getDirectDownloadUrl with 401/403, capability HMAC, and 302 redirect', async () => {
      const adapter = createMockAdapter();
      adapter.getStream.mockResolvedValue({
        stream: Readable.from([Buffer.from('%PDF-1.7')]),
        contentLength: 8,
      });
      adapter.getPresignedDownloadUrl.mockResolvedValue(
        'https://r2.signed.example/paper.pdf',
      );
      const blobId = '33333333-3333-4333-8333-333333333333';
      const hashHex = ContentHash.fromBuffer(
        Buffer.from('private-paper'),
      ).toHex();
      const blob = makeBlobRecord({
        id: blobId,
        contentHashHex: hashHex,
        sizeBytes: 120n,
        mimeType: 'application/pdf',
      });

      const blobRepo = createMockBlobRepo();
      blobRepo.findById.mockResolvedValue(blob);
      blobRepo.hasUserAccessToBlob.mockResolvedValue(false);

      const quotaRepo = createMockQuotaRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
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

      const controller = new FilesController(facade);
      const mockRes = () => {
        const headers = new Map<string, unknown>();
        const res: any = {
          statusCode: 0,
          status: jest.fn((c: number) => {
            res.statusCode = c;
            return res;
          }),
          header: jest.fn((k: string, v: unknown) => {
            headers.set(k.toLowerCase(), v);
            return res;
          }),
          send: jest.fn().mockReturnThis(),
          headers,
        };
        return res;
      };

      await expect(
        controller.streamBlobContent(
          blobId,
          'paper.pdf',
          undefined,
          { url: `/api/v1/files/${blobId}/content`, headers: {} } as any,
          mockRes(),
        ),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        controller.streamBlobContent(
          blobId,
          'paper.pdf',
          undefined,
          {
            url: `/api/v1/files/${blobId}/content`,
            headers: {},
            user: { id: 'outsider' },
          } as any,
          mockRes(),
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        controller.getDirectDownloadUrl('outsider', blobId, 'paper.pdf'),
      ).rejects.toThrow(ForbiddenException);

      const capUrl = accessService.signBlobUrl(blobId, {
        expiresInSeconds: 120,
        filename: 'paper.pdf',
      });
      const parsed = new URL(capUrl, 'http://localhost');
      const capRes = mockRes();
      await controller.streamBlobContent(
        blobId,
        'paper.pdf',
        undefined,
        { url: capUrl, headers: {} } as any,
        capRes,
        parsed.searchParams.get('exp')!,
        parsed.searchParams.get('sig')!,
      );
      expect(capRes.statusCode).toBe(200);

      blobRepo.hasUserAccessToBlob.mockResolvedValue(true);
      const redirRes = mockRes();
      await controller.streamBlobContent(
        blobId,
        'paper.pdf',
        undefined,
        {
          url: `/api/v1/files/${blobId}/content?redirect=1`,
          headers: {},
          user: { id: 'owner-1' },
        } as any,
        redirRes,
        undefined,
        undefined,
        '1',
      );
      expect(redirRes.statusCode).toBe(302);
      expect(redirRes.headers.get('location')).toBe(
        'https://r2.signed.example/paper.pdf',
      );

      const dlRes = await controller.getDirectDownloadUrl(
        'owner-1',
        blobId,
        'paper.pdf',
      );
      expect(dlRes).toEqual({
        url: 'https://r2.signed.example/paper.pdf',
        expiresIn: 300,
      });
    });

    it('rejects cross-space BOLA on presign, initiateMultipart, and getQuota when accessService denies access', async () => {
      const targetSpace = '44444444-4444-4444-8444-444444444444';
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      blobRepo.hasUserAccessToSpace.mockResolvedValue(false);
      const quotaRepo = createMockQuotaRepo();
      const blobService = new BlobService(adapter, blobRepo);
      const uploadService = new FilesUploadService(
        adapter,
        blobService,
        blobRepo,
        quotaRepo,
        createMockSessionRepo(),
      );
      const presignSpy = jest.spyOn(uploadService, 'presignUpload');
      const initiateSpy = jest.spyOn(uploadService, 'initiateMultipart');
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

      const controller = new FilesController(facade);

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

      expect(presignSpy).not.toHaveBeenCalled();
      expect(initiateSpy).not.toHaveBeenCalled();
      expect(quotaRepo.findBySpaceId).not.toHaveBeenCalled();
    });

    it('keeps attachBlobRef and detachBlobRef strictly idempotent per owner tuple', async () => {
      const adapter = createMockAdapter();
      const refs = new Map<string, any>();
      const blobRepo = createMockBlobRepo();
      blobRepo.incrementRefCount.mockResolvedValue(
        makeBlobRecord({ id: 'blob-1', contentHashHex: 'a'.repeat(64) }),
      );
      blobRepo.attachRef.mockImplementation(async (input) => {
        const k = `${input.ownerType}:${input.ownerId}`;
        const existing = refs.get(k);
        if (existing) return { created: false, ref: existing };
        const rec = {
          ...input,
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

      const quotaRepo = createMockQuotaRepo();
      quotaRepo.incrementUsage.mockResolvedValue(500n);
      quotaRepo.decrementUsage.mockResolvedValue(0n);

      const blobService = new BlobService(adapter, blobRepo);
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

      const refInput = {
        blobId: 'blob-1',
        spaceId: 'space-1',
        ownerType: 'attachment',
        ownerId: 'att-99',
        sizeBytes: 500n,
      };

      const first = await facade.attachBlobRef(refInput);
      const second = await facade.attachBlobRef(refInput);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(quotaRepo.incrementUsage).toHaveBeenCalledTimes(1);
      expect(blobRepo.incrementRefCount).toHaveBeenCalledTimes(1);

      expect(await facade.detachBlobRef('attachment', 'att-99')).toBe(true);
      expect(await facade.detachBlobRef('attachment', 'att-99')).toBe(false);
      expect(quotaRepo.decrementUsage).toHaveBeenCalledTimes(1);
      expect(blobRepo.decrementRefCount).toHaveBeenCalledTimes(1);
    });
  });
});
