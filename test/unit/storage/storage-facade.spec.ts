import { StorageFacade } from '@/modules/storage/application/facade/storage.facade';
import { UploadDirectUseCase } from '@/modules/storage/application/use-cases/upload/upload-direct.use-case';
import { IStorageDriver } from '@/modules/storage/domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '@/modules/storage/domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '@/modules/storage/domain/ports/storage-blob.repository.port';
import { IStorageQuotaRepository } from '@/modules/storage/domain/ports/storage-quota.repository.port';
import { StorageRedisCacheService } from '@/modules/storage/infrastructure/cache/storage-redis-cache.service';
import {
  StorageBlob,
  BlobStatus,
} from '@/modules/storage/domain/entities/storage-blob.entity';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { ContentHash } from '@/modules/storage/domain/value-objects/content-hash.vo';
import { StorageKey } from '@/modules/storage/domain/value-objects/storage-key.vo';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';

describe('StorageFacade & UploadDirectUseCase Integration Suite', () => {
  let facade: StorageFacade;
  let uploadDirectUseCase: UploadDirectUseCase;
  let mockDriver: jest.Mocked<IStorageDriver>;
  let mockNodeRepo: jest.Mocked<IStorageNodeRepository>;
  let mockBlobRepo: jest.Mocked<IStorageBlobRepository>;
  let mockQuotaRepo: jest.Mocked<IStorageQuotaRepository>;
  let mockCache: jest.Mocked<StorageRedisCacheService>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;

  const nodesInDb = new Map<string, StorageNode>();
  const blobsInDb = new Map<string, StorageBlob>();
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
    };

    mockNodeRepo = {
      findById: jest
        .fn()
        .mockImplementation(async (id: string) => nodesInDb.get(id) || null),
      create: jest.fn().mockImplementation(async (node: StorageNode) => {
        nodesInDb.set(node.id, node);
        return node;
      }),
      update: jest.fn().mockImplementation(async (node: StorageNode) => {
        nodesInDb.set(node.id, node);
        return node;
      }),
      delete: jest.fn().mockImplementation(async (id: string) => {
        nodesInDb.delete(id);
      }),
      deleteMany: jest.fn(),
      list: jest.fn(),
      findByBlobId: jest.fn(),
      softDeleteSubtree: jest.fn(),
      restoreSubtree: jest.fn(),
      findSubtreeNodes: jest.fn(),
      findExpiredTrash: jest.fn(),
    };

    mockBlobRepo = {
      findById: jest
        .fn()
        .mockImplementation(async (id: string) => blobsInDb.get(id) || null),
      findByHash: jest.fn().mockImplementation(async (hash: ContentHash) => {
        for (const blob of blobsInDb.values()) {
          if (blob.contentHash.equals(hash)) {
            return blob;
          }
        }
        return null;
      }),
      create: jest.fn().mockImplementation(async (blob: StorageBlob) => {
        blobsInDb.set(blob.id, blob);
        return blob;
      }),
      update: jest.fn().mockImplementation(async (blob: StorageBlob) => {
        blobsInDb.set(blob.id, blob);
        return blob;
      }),
      delete: jest.fn().mockImplementation(async (id: string) => {
        blobsInDb.delete(id);
      }),
      findTombstonedBlobs: jest.fn(),
    };

    mockQuotaRepo = {
      findByScope: jest.fn(),
      upsert: jest.fn(),
      incrementUsage: jest.fn().mockResolvedValue(1000n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
      reconcileUsage: jest.fn(),
    };

    mockCache = {
      getFolderListing: jest.fn().mockResolvedValue(null),
      setFolderListing: jest.fn(),
      invalidateFolder: jest.fn(),
      invalidateScopeTree: jest.fn(),
      getPresignedUrl: jest.fn(),
      setPresignedUrl: jest.fn(),
      invalidatePresignedUrl: jest.fn(),
      getCachedQuota: jest.fn(),
      setCachedQuota: jest.fn(),
      invalidateQuota: jest.fn(),
    } as any;

    mockEventEmitter = {
      emit: jest.fn(),
    } as any;

    uploadDirectUseCase = new UploadDirectUseCase(
      mockDriver,
      mockNodeRepo,
      mockBlobRepo,
      mockQuotaRepo,
      mockCache,
      mockEventEmitter,
    );

    facade = new StorageFacade(
      mockDriver,
      mockNodeRepo,
      mockBlobRepo,
      uploadDirectUseCase,
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
      source: 'library',
    });

    expect(result.fileId).toBeDefined();
    expect(result.filename).toBe('qml_paper.pdf');
    expect(result.size).toBe(pdfContent.length);
    expect(result.url).toBe(
      `/api/files/${encodeURIComponent(result.fileId)}/content`,
    );

    // Verify written to mock driver
    expect(mockDriver.put).toHaveBeenCalledTimes(1);
    expect(blobsInDb.size).toBe(1);
    expect(nodesInDb.size).toBe(1);

    // Verify node has scope Library
    const storedNode = nodesInDb.get(result.fileId);
    expect(storedNode?.scope).toBe('Library');
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

  it('should stream binary stream directly via getFileStream', async () => {
    const content = Buffer.from('%PDF-1.7 Large Dataset or Paper Stream Test');
    const uploaded = await facade.uploadFile({
      userId: 'user-stream',
      filename: 'paper.pdf',
      buffer: content,
      mimeType: 'application/pdf',
    });

    const streamResult = await facade.getFileStream(uploaded.fileId);
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
    expect(uploadRes.storageKey).toContain('uploads/user-presign/');
  });

  it('should check quota usage for system consumers', async () => {
    const quota = await facade.checkQuota('user-123');
    expect(quota).toBeDefined();
    expect(quota.maxBytes).toBeGreaterThan(0);
  });
});
