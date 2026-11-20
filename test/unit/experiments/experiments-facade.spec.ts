import {
  BlobStatus,
  DEFAULT_STORAGE_QUOTA_BYTES,
  FilesFacade,
  StorageBlobRecord,
} from '@/modules/files';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';
import { ExperimentsFacade } from '@/modules/experiments';
import { ExperimentNode } from '@/modules/experiments/domain/node.domain';
import { NodeRepository } from '@/modules/experiments/repositories/node.repository';
import { ExperimentsCacheService } from '@/modules/experiments/services/cache.service';
import { StreamService } from '@/modules/experiments/services/stream.service';
import { UploadService } from '@/modules/experiments/services/upload.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';

describe('ExperimentsFacade & UploadService Integration Suite', () => {
  let facade: ExperimentsFacade;
  let uploadService: UploadService;
  let mockDriver: jest.Mocked<IStorageAdapter>;
  let mockNodeRepo: jest.Mocked<NodeRepository>;
  let mockBlobRepo: jest.Mocked<BlobRepository>;
  let mockQuotaRepo: jest.Mocked<QuotaRepository>;
  let mockCache: jest.Mocked<ExperimentsCacheService>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;

  const nodesInDb = new Map<string, ExperimentNode>();
  const blobsInDb = new Map<string, StorageBlobRecord>();
  const driverStorage = new Map<string, Buffer>();

  beforeEach(() => {
    nodesInDb.clear();
    blobsInDb.clear();
    driverStorage.clear();

    mockDriver = {
      put: jest.fn().mockImplementation(async (key: string, data: Buffer) => {
        driverStorage.set(key, data);
      }),
      getStream: jest.fn().mockImplementation(async (key: string) => {
        const buf = driverStorage.get(key) || Buffer.from('mock-content');
        return { stream: Readable.from(buf), contentLength: buf.length };
      }),
      stat: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      exists: jest.fn(),
      copy: jest.fn(),
      getPresignedUploadUrl: jest.fn(),
      getPresignedDownloadUrl: jest.fn(),
      initiateMultipartUpload: jest.fn(),
      getPresignedPartUploadUrl: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      listUploadedParts: jest.fn(),
      applyLifecycleRules: jest.fn().mockResolvedValue(undefined),
      getLifecycleRules: jest.fn().mockResolvedValue([]),
    };

    mockNodeRepo = {
      findById: jest
        .fn()
        .mockImplementation(async (id: string) => nodesInDb.get(id) || null),
      create: jest.fn().mockImplementation(async (node: ExperimentNode) => {
        nodesInDb.set(node.id, node);
        return node;
      }),
      update: jest.fn().mockImplementation(async (node: ExperimentNode) => {
        nodesInDb.set(node.id, node);
        return node;
      }),
      delete: jest.fn().mockImplementation(async (id: string) => {
        nodesInDb.delete(id);
      }),
      deleteMany: jest.fn(),
      list: jest.fn(),
      softDeleteSubtree: jest.fn(),
      restoreSubtree: jest.fn(),
      findSubtreeNodes: jest.fn(),
      findExpiredTrash: jest.fn(),
      isDescendant: jest.fn().mockResolvedValue(false),
      getFolderPath: jest.fn().mockResolvedValue([]),
      listSharedWithUser: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      shareNode: jest.fn(),
    } as unknown as jest.Mocked<NodeRepository>;

    mockBlobRepo = {
      findById: jest
        .fn()
        .mockImplementation(async (id: string) => blobsInDb.get(id) || null),
      findByHash: jest.fn().mockImplementation(async (hashHex: string) => {
        for (const blob of blobsInDb.values()) {
          if (blob.contentHashHex === hashHex) {
            return blob;
          }
        }
        return null;
      }),
      create: jest.fn().mockImplementation(async (input) => {
        const blob: StorageBlobRecord = {
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
        blobsInDb.set(blob.id, blob);
        return blob;
      }),
      delete: jest.fn().mockImplementation(async (id: string) => {
        blobsInDb.delete(id);
      }),
      incrementRefCount: jest.fn().mockImplementation(async (id: string) => {
        const blob = blobsInDb.get(id);
        if (!blob) throw new Error('Blob not found');
        const updated: StorageBlobRecord = {
          ...blob,
          status: BlobStatus.READY,
          refCount: blob.refCount + 1,
        };
        blobsInDb.set(id, updated);
        return updated;
      }),
      decrementRefCount: jest.fn().mockImplementation(async (id: string) => {
        const blob = blobsInDb.get(id);
        if (!blob) throw new Error('Blob not found');
        const newCount = Math.max(0, blob.refCount - 1);
        const updated: StorageBlobRecord = {
          ...blob,
          status: newCount === 0 ? BlobStatus.DELETED : BlobStatus.READY,
          refCount: newCount,
        };
        blobsInDb.set(id, updated);
        return updated;
      }),
    } as unknown as jest.Mocked<BlobRepository>;

    mockQuotaRepo = {
      findBySpaceId: jest.fn().mockResolvedValue(null),
      assertAvailable: jest.fn(async (_spaceId, requiredBytes: bigint) => {
        if (requiredBytes > DEFAULT_STORAGE_QUOTA_BYTES) {
          throw new BadRequestException('Storage quota exceeded');
        }
      }),
      incrementUsage: jest.fn().mockResolvedValue(1000n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
    } as unknown as jest.Mocked<QuotaRepository>;

    mockCache = {
      getFolderListing: jest.fn().mockResolvedValue(null),
      setFolderListing: jest.fn(),
      invalidateFolder: jest.fn(),
      invalidateScopeTree: jest.fn(),
      getPresignedUrl: jest.fn(),
      setPresignedUrl: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockEventEmitter = {
      emit: jest.fn(),
    } as any;

    const blobService = new BlobService(mockDriver, mockBlobRepo);
    const filesFacade = new FilesFacade(
      mockDriver,
      blobService,
      mockBlobRepo,
      mockQuotaRepo,
      new FilesUploadService(
        mockDriver,
        blobService,
        mockBlobRepo,
        mockQuotaRepo,
        {} as SessionRepository,
      ),
    );

    uploadService = new UploadService(
      filesFacade,
      mockNodeRepo,
      mockCache,
      mockEventEmitter,
    );

    const mockAccessPolicy = {
      assertCanAccess: jest.fn().mockResolvedValue(undefined),
    } as any;

    facade = new ExperimentsFacade(
      filesFacade,
      mockNodeRepo,
      uploadService,
      {} as any,
      new StreamService(filesFacade, mockNodeRepo, mockCache, mockAccessPolicy),
      {} as any,
      mockAccessPolicy,
    );
  });

  it('should upload a new PDF paper and store it in both logical node and physical blob', async () => {
    const pdfContent = Buffer.from(
      '%PDF-1.7 Quantum Machine Learning Research Paper',
    );
    const result = await facade.uploadFile({
      userId: 'user-researcher-1',
      filename: 'qml_paper.pdf',
      buffer: pdfContent,
      mimeType: 'application/pdf',
    });

    expect(result.fileId).toBeDefined();
    expect(result.filename).toBe('qml_paper.pdf');
    expect(result.size).toBe(pdfContent.length);
    expect(result.url).toBe(
      `/api/v1/experiments/files/${encodeURIComponent(result.fileId)}/content`,
    );

    // Verify written to mock driver
    expect(mockDriver.put).toHaveBeenCalledTimes(1);
    expect(blobsInDb.size).toBe(1);
    expect(nodesInDb.size).toBe(1);

    // Verify node has Personal scope
    const storedNode = nodesInDb.get(result.fileId);
    expect(storedNode?.scope).toBe('Personal');
  });

  it('should perform Content-Addressable Deduplication (CAS) for identical files', async () => {
    const identicalPdf = Buffer.from(
      '%PDF-1.7 Identical Content Across Two Different Authors',
    );

    // 1st Upload by Researcher 1
    const res1 = await facade.uploadFile({
      userId: 'tenant-team-1',
      filename: 'researcher1_copy.pdf',
      buffer: identicalPdf,
      mimeType: 'application/pdf',
    });

    expect(mockDriver.put).toHaveBeenCalledTimes(1);
    expect(blobsInDb.size).toBe(1);

    // 2nd Upload with exact same content by Researcher 2 (in same team/tenant)
    const res2 = await facade.uploadFile({
      userId: 'tenant-team-1',
      filename: 'researcher2_copy.pdf',
      buffer: identicalPdf,
      mimeType: 'application/pdf',
    });

    // CRITICAL CAS INVARIANT: Driver put MUST NOT be called again! Zero network bandwidth!
    expect(mockDriver.put).toHaveBeenCalledTimes(1);

    // Still only 1 physical blob in database
    expect(blobsInDb.size).toBe(1);
    const sharedBlob = Array.from(blobsInDb.values())[0];
    expect(sharedBlob.refCount).toBe(2); // refCount increased to 2

    // But 2 distinct logical nodes exist in user drive
    expect(nodesInDb.size).toBe(2);
    expect(res1.fileId).not.toBe(res2.fileId);
  });

  it('should read owned file and stream correct bytes back', async () => {
    const content = Buffer.from('%PDF-1.7 Content verification stream test');
    const uploaded = await facade.uploadFile({
      userId: 'user-123',
      filename: 'test.pdf',
      buffer: content,
      mimeType: 'application/pdf',
    });

    const readResult = await facade.readOwnedFile({
      fileId: uploaded.fileId,
      userId: 'user-123',
    });

    expect(readResult.fileId).toBe(uploaded.fileId);
    expect(readResult.filename).toBe('test.pdf');
    expect(readResult.buffer.toString()).toBe(content.toString());
  });

  it('should reject dangerous executable uploads with BadRequestException', async () => {
    const maliciousBuffer = Buffer.from('MZ... executable payload');
    await expect(
      facade.uploadFile({
        userId: 'user-attacker',
        filename: 'malware.exe',
        buffer: maliciousBuffer,
        mimeType: 'application/x-msdownload',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should stream binary stream directly via getOwnedFileStream', async () => {
    const content = Buffer.from('%PDF-1.7 Large Dataset or Paper Stream Test');
    const uploaded = await facade.uploadFile({
      userId: 'user-stream',
      filename: 'paper.pdf',
      buffer: content,
      mimeType: 'application/pdf',
    });

    const streamResult = await facade.getOwnedFileStream({
      fileId: uploaded.fileId,
      userId: 'user-stream',
    });
    expect(streamResult.mimeType).toBe('application/pdf');
    expect(streamResult.filename).toBe('paper.pdf');
    expect(streamResult.stream).toBeDefined();
  });

  it('should generate presigned download and upload URLs for system consumers', async () => {
    mockDriver.getPresignedDownloadUrl.mockResolvedValueOnce(
      'https://storage.flux.ai/download/signed-url',
    );
    mockDriver.getPresignedUploadUrl.mockResolvedValueOnce(
      'https://storage.flux.ai/upload/signed-url',
    );

    const content = Buffer.from('%PDF-1.7 Presign Download Test');
    const uploaded = await facade.uploadFile({
      userId: 'user-presign',
      filename: 'dataset.pdf',
      buffer: content,
      mimeType: 'application/pdf',
    });

    const downloadUrl = await facade.getPresignedDownloadUrl(uploaded.fileId);
    expect(downloadUrl).toBe('https://storage.flux.ai/download/signed-url');

    const uploadRes = await facade.getPresignedUploadUrl({
      userId: 'user-presign',
      filename: 'large-dataset.csv',
      mimeType: 'text/csv',
      sizeBytes: 50 * 1024 * 1024,
    });
    expect(uploadRes.uploadUrl).toBe(
      'https://storage.flux.ai/upload/signed-url',
    );
    expect(uploadRes.storageKey).toContain('uploads/staging/user-presign/');
  });
});
