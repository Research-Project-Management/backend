import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  LocalStorageAdapter,
  PresignService,
  QuotaService,
  StorageBlob,
  StorageKey,
  StorageQuota,
  UploadSession,
  UploadSessionStatus,
} from '@/modules/files';

function createInMemoryRepos() {
  const blobs = new Map<string, StorageBlob>();
  const sessions = new Map<string, UploadSession>();

  const blobRepo: jest.Mocked<IBlobRepository> = {
    findById: jest.fn(async (id) => blobs.get(id) ?? null),
    findByHash: jest.fn(async (hash) => {
      const hex = hash.toHex();
      for (const blob of blobs.values()) {
        if (blob.contentHash.toHex() === hex) return blob;
      }
      return null;
    }),
    create: jest.fn(async (blob) => {
      blobs.set(blob.id, blob);
      return blob;
    }),
    delete: jest.fn(async (id) => {
      blobs.delete(id);
    }),
    findTombstonedBlobs: jest.fn().mockResolvedValue([]),
    incrementRefCount: jest.fn(async (id) => {
      const blob = blobs.get(id);
      if (!blob) return null;
      blob.incrementRef();
      return blob;
    }),
    decrementRefCount: jest.fn().mockResolvedValue(null),
    claimBlobForPurge: jest.fn().mockResolvedValue(true),
    restoreClaimedBlob: jest.fn().mockResolvedValue(undefined),
  };

  let usedBytes = 0n;
  const maxBytes = 100 * 1024 * 1024;
  const quotaRepo: jest.Mocked<IQuotaRepository> = {
    findBySpaceId: jest.fn(async (spaceId) => {
      return new StorageQuota({
        id: 'quota-1',
        spaceId: spaceId ?? 'user-1',
        usedBytes,
        maxBytes: BigInt(maxBytes),
      });
    }),
    incrementUsage: jest.fn(async (_spaceId, bytes) => {
      usedBytes += bytes;
      return usedBytes;
    }),
    decrementUsage: jest.fn(async (_spaceId, bytes) => {
      usedBytes = usedBytes > bytes ? usedBytes - bytes : 0n;
      return usedBytes;
    }),
  };

  const sessionRepo: jest.Mocked<ISessionRepository> = {
    create: jest.fn(async (session) => {
      sessions.set(session.id, session);
      return session;
    }),
    findById: jest.fn(async (id) => sessions.get(id) ?? null),
    update: jest.fn(async (session) => {
      sessions.set(session.id, session);
      return session;
    }),
    findExpiredSessions: jest.fn().mockResolvedValue([]),
  };

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
    const quotaService = new QuotaService(repos.quotaRepo);
    const presignService = new PresignService(
      blobService,
      quotaService,
      repos.sessionRepo,
    );
    const streamService = new FileStreamService(blobService);
    const facade = new FilesFacade(
      blobService,
      quotaService,
      presignService,
      streamService,
    );

    controller = new FilesController(facade, blobService);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('initiates, signs part URLs (GET & POST), assembles chunks, and promotes CAS blob', async () => {
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

    const postUrlRes = await controller.postMultipartPartUrl('user-1', {
      sessionId: initRes.sessionId,
      partNumber: 1,
    });
    expect(postUrlRes.partNumber).toBe(1);
    expect(postUrlRes.uploadUrl).toContain('/api/v1/files/local-upload-part');

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
    const hash = ContentHash.fromBuffer(existingBytes);
    const existingBlob = new StorageBlob({
      id: 'blob-existing-mpu',
      contentHash: hash,
      sizeBytes: BigInt(existingBytes.length),
      s3Key: StorageKey.forBlob(hash.toHex()),
      s3Bucket: 'flux',
      status: BlobStatus.READY,
      refCount: 1,
    });
    repos.blobs.set(existingBlob.id, existingBlob);

    const res = await controller.initiateMultipart('user-1', {
      filename: 'dataset.parquet',
      mimeType: 'application/octet-stream',
      totalSize: existingBytes.length,
      expectedHash: hash.toHex(),
    });

    expect(res.deduplicated).toBe(true);
    expect(res.fileId).toBe(existingBlob.id);
    expect(res.url).toBe(`/api/v1/files/${existingBlob.id}/content`);
    expect(existingBlob.refCount).toBe(2);
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
});
