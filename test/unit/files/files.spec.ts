import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import {
  BlobService,
  BlobStatus,
  ContentHash,
  FilesController,
  FilesFacade,
  FileStreamService,
  IBlobRepository,
  IQuotaRepository,
  ISessionRepository,
  IStorageAdapter,
  LocalStorageAdapter,
  PresignService,
  QuotaService,
  StorageBlob,
  StorageKey,
  StorageQuota,
} from '@/modules/files';

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

describe('FilesModule Standalone Capabilities & Hardening', () => {
  describe('BlobService Atomic CAS GC (reclaimOrphanBlobs)', () => {
    it('skips physical and DB deletion when claimBlobForPurge returns false', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hash = ContentHash.fromBuffer(Buffer.from('concurrent-revived'));
      const orphan = new StorageBlob({
        id: 'blob-race-1',
        contentHash: hash,
        sizeBytes: 128n,
        s3Key: StorageKey.forBlob(hash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.DELETED,
        refCount: 0,
      });

      blobRepo.findTombstonedBlobs.mockResolvedValue([orphan]);
      blobRepo.claimBlobForPurge!.mockResolvedValue(false);

      const service = new BlobService(adapter, blobRepo);
      const count = await service.reclaimOrphanBlobs(10);

      expect(count).toBe(0);
      expect(adapter.delete).not.toHaveBeenCalled();
      expect(blobRepo.delete).not.toHaveBeenCalled();
      expect(blobRepo.restoreClaimedBlob).not.toHaveBeenCalled();
    });

    it('deletes physical object and DB record when claimBlobForPurge returns true', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hash = ContentHash.fromBuffer(Buffer.from('dead-orphan'));
      const orphan = new StorageBlob({
        id: 'blob-dead-1',
        contentHash: hash,
        sizeBytes: 256n,
        s3Key: StorageKey.forBlob(hash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.DELETED,
        refCount: 0,
      });

      blobRepo.findTombstonedBlobs.mockResolvedValue([orphan]);
      blobRepo.claimBlobForPurge!.mockResolvedValue(true);

      const service = new BlobService(adapter, blobRepo);
      const count = await service.reclaimOrphanBlobs(10);

      expect(count).toBe(1);
      expect(adapter.delete).toHaveBeenCalledWith(orphan.s3Key.value());
      expect(blobRepo.delete).toHaveBeenCalledWith('blob-dead-1');
      expect(blobRepo.restoreClaimedBlob).not.toHaveBeenCalled();
    });

    it('restores claimed blob and skips DB hard delete if adapter.delete throws', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const hash = ContentHash.fromBuffer(Buffer.from('s3-error-orphan'));
      const orphan = new StorageBlob({
        id: 'blob-err-1',
        contentHash: hash,
        sizeBytes: 512n,
        s3Key: StorageKey.forBlob(hash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.DELETED,
        refCount: 0,
      });

      blobRepo.findTombstonedBlobs.mockResolvedValue([orphan]);
      blobRepo.claimBlobForPurge!.mockResolvedValue(true);
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
      expect(result.blob.s3Key.value()).toBe(canonicalKey);
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

  describe('QuotaService & StorageNode-Free PresignService / FilesFacade', () => {
    it('enforces quota limit on assertAvailable and delegates reserve/release', async () => {
      const quotaRepo: jest.Mocked<IQuotaRepository> = {
        findByScope: jest.fn().mockResolvedValue(
          new StorageQuota({
            id: 'q1',
            userId: 'user-1',
            usedBytes: 900n,
            maxBytes: 1000n,
          }),
        ),
        incrementUsage: jest.fn().mockResolvedValue(950n),
        decrementUsage: jest.fn().mockResolvedValue(900n),
      };

      const quotaService = new QuotaService(quotaRepo);

      await expect(
        quotaService.assertAvailable('user-1', null, 50n),
      ).resolves.toBeUndefined();
      await expect(
        quotaService.assertAvailable('user-1', null, 200n),
      ).rejects.toThrow('Storage quota exceeded');

      expect(await quotaService.reserve('user-1', null, 50n)).toBe(950n);
      expect(await quotaService.release('user-1', null, 50n)).toBe(900n);
    });

    it('short-circuits initiateMultipart via Instant CAS Deduplication without creating session', async () => {
      const adapter = createMockAdapter();
      const blobRepo = createMockBlobRepo();
      const blobService = new BlobService(adapter, blobRepo);

      const hash = ContentHash.fromBuffer(Buffer.from('existing-dataset'));
      const existingBlob = new StorageBlob({
        id: 'blob-existing-1',
        contentHash: hash,
        sizeBytes: 10_000_000n,
        s3Key: StorageKey.forBlob(hash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
        refCount: 1,
      });

      blobRepo.findByHash.mockResolvedValue(existingBlob);
      blobRepo.incrementRefCount.mockResolvedValue(
        new StorageBlob({
          id: existingBlob.id,
          contentHash: hash,
          sizeBytes: existingBlob.sizeBytes,
          s3Key: existingBlob.s3Key,
          s3Bucket: 'flux',
          status: BlobStatus.READY,
          refCount: 2,
        }),
      );

      const sessionRepo = {
        create: jest.fn(),
        findById: jest.fn(),
        update: jest.fn(),
        findExpiredSessions: jest.fn(),
      } as jest.Mocked<ISessionRepository>;

      const quotaRepo: jest.Mocked<IQuotaRepository> = {
        findByScope: jest.fn().mockResolvedValue(
          new StorageQuota({
            id: 'q1',
            userId: 'user-1',
            usedBytes: 0n,
            maxBytes: 500_000_000n,
          }),
        ),
        incrementUsage: jest.fn().mockResolvedValue(10_000_000n),
        decrementUsage: jest.fn().mockResolvedValue(0n),
      };

      const quotaService = new QuotaService(quotaRepo);
      const presignService = new PresignService(
        blobService,
        quotaService,
        sessionRepo,
      );
      const streamService = new FileStreamService(blobService);
      const facade = new FilesFacade(
        blobService,
        quotaService,
        presignService,
        streamService,
      );

      const res = await facade.initiateMultipart({
        userId: 'user-1',
        filename: 'large-dataset.parquet',
        mimeType: 'application/octet-stream',
        totalSize: 10_000_000,
        expectedHash: hash.toHex(),
      });

      expect(res.deduplicated).toBe(true);
      expect(res.blob?.id).toBe(existingBlob.id);
      expect(adapter.initiateMultipartUpload).not.toHaveBeenCalled();
      expect(sessionRepo.create).not.toHaveBeenCalled();
      expect(blobRepo.incrementRefCount).toHaveBeenCalledWith(existingBlob.id);
      expect(quotaRepo.incrementUsage).toHaveBeenCalledWith(
        'user-1',
        null,
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

      const quotaRepo: jest.Mocked<IQuotaRepository> = {
        findByScope: jest.fn(),
        incrementUsage: jest
          .fn()
          .mockRejectedValue(
            new BadRequestException('Storage quota exceeded'),
          ),
        decrementUsage: jest.fn(),
      };

      const sessionRepo = {
        create: jest.fn(),
        findById: jest.fn(),
        update: jest.fn(),
        findExpiredSessions: jest.fn(),
      } as jest.Mocked<ISessionRepository>;

      const quotaService = new QuotaService(quotaRepo);
      const presignService = new PresignService(
        blobService,
        quotaService,
        sessionRepo,
      );

      await expect(
        presignService.completePresignedUpload({
          userId: 'user-1',
          storageKey: stagingKey,
          filename: 'over-quota.txt',
          mimeType: 'text/plain',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow('Storage quota exceeded');

      expect(adapter.delete).toHaveBeenCalledWith(stagingKey);
    });

    it('uploads, reads, and streams PNG content via FilesFacade & FilesController without StorageNode', async () => {
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
      ]);

      const storedBlobs = new Map<string, StorageBlob>();
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

      const blobRepo: jest.Mocked<IBlobRepository> = {
        ...createMockBlobRepo(),
        create: jest.fn(async (blob) => {
          storedBlobs.set(blob.id, blob);
          return blob;
        }),
        findById: jest.fn(async (id) => storedBlobs.get(id) ?? null),
      };

      const blobService = new BlobService(adapter, blobRepo);
      const quotaRepo: jest.Mocked<IQuotaRepository> = {
        findByScope: jest.fn().mockResolvedValue(
          new StorageQuota({
            id: 'q1',
            userId: 'user-1',
            usedBytes: 0n,
            maxBytes: 1_000_000n,
          }),
        ),
        incrementUsage: jest.fn().mockResolvedValue(BigInt(pngBytes.length)),
        decrementUsage: jest.fn().mockResolvedValue(0n),
      };
      const sessionRepo = {
        create: jest.fn(),
        findById: jest.fn(),
        update: jest.fn(),
        findExpiredSessions: jest.fn(),
      } as jest.Mocked<ISessionRepository>;

      const quotaService = new QuotaService(quotaRepo);
      const presignService = new PresignService(
        blobService,
        quotaService,
        sessionRepo,
      );
      const streamService = new FileStreamService(blobService);
      const facade = new FilesFacade(
        blobService,
        quotaService,
        presignService,
        streamService,
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

      const controller = new FilesController(facade, blobService);
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
        { url: uploaded.url, headers: {} } as any,
        mockReply,
      );

      expect(statusCode).toBe(200);
      expect(headers.get('content-type')).toBe('image/png');
      expect(headers.get('content-disposition')).toContain('inline');
      expect(sentBody).toBeDefined();
    });
  });
});
