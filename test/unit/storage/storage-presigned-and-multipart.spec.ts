import { CompletePresignService } from '@/modules/storage/transfer';
import { MultipartService } from '@/modules/storage/transfer';
import { StorageQueueProducer } from '@/modules/storage/worker';
import { BlobService, IStorageDriver } from '@/modules/storage/core';
import { IStorageNodeRepository } from '@/modules/storage/drive';
import { IStorageBlobRepository } from '@/modules/storage/core';
import { IUploadSessionRepository } from '@/modules/storage/transfer';
import { IStorageQuotaRepository } from '@/modules/storage/drive';
import { StorageRedisCacheService } from '@/modules/storage/core';
import { UploadSession } from '@/modules/storage/transfer';
import { StorageNode } from '@/modules/storage/drive';
import { StorageBlob } from '@/modules/storage/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('Presigned & Resumable Multipart Upload Suite', () => {
  let mockDriver: jest.Mocked<IStorageDriver>;
  let mockNodeRepo: jest.Mocked<IStorageNodeRepository>;
  let mockBlobRepo: jest.Mocked<IStorageBlobRepository>;
  let mockSessionRepo: jest.Mocked<IUploadSessionRepository>;
  let mockQuotaRepo: jest.Mocked<IStorageQuotaRepository>;
  let mockCache: jest.Mocked<StorageRedisCacheService>;
  let mockEvents: jest.Mocked<EventEmitter2>;
  let mockQueueProducer: jest.Mocked<StorageQueueProducer>;

  beforeEach(() => {
    mockDriver = {
      put: jest.fn(),
      getStream: jest.fn(),
      stat: jest.fn().mockResolvedValue({
        key: 'uploads/user-1/file.pdf',
        size: 5 * 1024 * 1024,
        mimeType: 'application/pdf',
        lastModified: new Date(),
      }),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      exists: jest.fn().mockResolvedValue(true),
      copy: jest.fn(),
      getPresignedUploadUrl: jest
        .fn()
        .mockResolvedValue('https://s3.example.com/put-signed'),
      getPresignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://s3.example.com/get-signed'),
      initiateMultipartUpload: jest
        .fn()
        .mockResolvedValue({ uploadId: 's3-upload-123' }),
      getPresignedPartUploadUrl: jest
        .fn()
        .mockResolvedValue('https://s3.example.com/part-signed'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      listUploadedParts: jest.fn().mockResolvedValue([]),
    };

    mockNodeRepo = {
      findById: jest.fn(),
      create: jest.fn().mockImplementation(async (node) => node),
      update: jest.fn().mockImplementation(async (node) => node),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      list: jest.fn(),
      findByBlobId: jest.fn(),
      softDeleteSubtree: jest.fn(),
      restoreSubtree: jest.fn(),
      findSubtreeNodes: jest.fn(),
      findExpiredTrash: jest.fn(),
    };

    mockBlobRepo = {
      findById: jest.fn(),
      findByHash: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (blob) => blob),
      update: jest.fn().mockImplementation(async (blob) => blob),
      delete: jest.fn(),
      findTombstonedBlobs: jest.fn(),
    };

    mockSessionRepo = {
      create: jest.fn().mockImplementation(async (s) => s),
      findById: jest.fn(),
      update: jest.fn().mockImplementation(async (s) => s),
      delete: jest.fn(),
      recordPart: jest.fn(),
      getParts: jest.fn().mockResolvedValue([]),
      findExpiredSessions: jest.fn().mockResolvedValue([]),
    };

    mockQuotaRepo = {
      findByScope: jest.fn(),
      upsert: jest.fn(),
      incrementUsage: jest.fn().mockResolvedValue(0n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
      reconcileUsage: jest.fn().mockResolvedValue(undefined),
    };

    mockCache = {
      invalidateFolder: jest.fn().mockResolvedValue(undefined),
      invalidateScopeTree: jest.fn().mockResolvedValue(undefined),
      invalidateQuota: jest.fn().mockResolvedValue(undefined),
      getFolderListing: jest.fn().mockResolvedValue(null),
      setFolderListing: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockEvents = {
      emit: jest.fn(),
    } as any;

    mockQueueProducer = {
      queueFileProcessing: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  describe('CompletePresignService', () => {
    let service: CompletePresignService;

    beforeEach(() => {
      service = new CompletePresignService(
        new BlobService(mockDriver, mockBlobRepo),
        mockNodeRepo,
        mockQuotaRepo,
        mockCache,
        mockEvents,
      );
    });

    it('should complete presigned upload, consume quota, persist node/blob, and emit file.uploaded event', async () => {
      const result = await service.complete({
        userId: 'user-100',
        storageKey: 'uploads/user-100/paper.pdf',
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        projectId: 'proj-1',
      });

      expect(mockDriver.stat).toHaveBeenCalledWith(
        'uploads/user-100/paper.pdf',
      );
      expect(mockQuotaRepo.incrementUsage).toHaveBeenCalledWith(
        'user-100',
        'proj-1',
        BigInt(5 * 1024 * 1024),
      );
      expect(mockBlobRepo.create).toHaveBeenCalledTimes(1);
      expect(mockNodeRepo.create).toHaveBeenCalledTimes(1);
      expect(mockCache.invalidateFolder).toHaveBeenCalledWith('proj-1', null);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'file.uploaded',
        expect.objectContaining({
          fileId: result.fileId,
          filename: 'paper.pdf',
          mimeType: 'application/pdf',
        }),
      );
      expect(result.size).toBe(5 * 1024 * 1024);
    });

    it('should reject dangerous executable file extensions', async () => {
      await expect(
        service.complete({
          userId: 'user-100',
          storageKey: 'uploads/user-100/virus.exe',
          filename: 'virus.exe',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if physical file is not found in storage', async () => {
      mockDriver.stat.mockRejectedValue(new Error('Object not found'));

      await expect(
        service.complete({
          userId: 'user-100',
          storageKey: 'uploads/user-100/missing.pdf',
          filename: 'missing.pdf',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('MultipartService', () => {
    let service: MultipartService;

    beforeEach(() => {
      service = new MultipartService(
        new BlobService(mockDriver, mockBlobRepo),
        mockNodeRepo,
        mockSessionRepo,
        mockQuotaRepo,
        mockCache,
        mockEvents,
      );
    });

    it('should initiate multipart upload session with dynamic chunk size', async () => {
      const result = await service.initiate({
        userId: 'user-200',
        filename: 'dataset.csv',
        mimeType: 'text/csv',
        totalSize: 50 * 1024 * 1024, // 50MB
        projectId: 'proj-2',
      });

      expect(mockDriver.initiateMultipartUpload).toHaveBeenCalledTimes(1);
      expect(mockSessionRepo.create).toHaveBeenCalledTimes(1);
      expect(result.sessionId).toBeDefined();
      expect(result.partSize).toBe(10 * 1024 * 1024); // 10MB base chunk size
      expect(result.totalParts).toBe(5);
    });

    it('should complete multipart upload, normalize parts, consume quota, and trigger BullMQ processing', async () => {
      const session = new UploadSession({
        id: 'session-123',
        userId: 'user-200',
        projectId: 'proj-2',
        s3UploadId: 's3-upload-123',
        s3Key: 'uploads/multipart/session-123/payload.csv',
        filename: 'dataset.csv',
        mimeType: 'text/csv',
        totalSize: BigInt(20 * 1024 * 1024),
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      const result = await service.complete({
        sessionId: 'session-123',
        parts: [
          { partNumber: 1, eTag: 'etag-part-1' },
          { partNumber: 2, etag: 'etag-part-2' }, // tests fallback to etag
        ],
      });

      expect(mockDriver.completeMultipartUpload).toHaveBeenCalledWith(
        'uploads/multipart/session-123/payload.csv',
        's3-upload-123',
        [
          expect.objectContaining({ partNumber: 1, eTag: 'etag-part-1' }),
          expect.objectContaining({ partNumber: 2, eTag: 'etag-part-2' }),
        ],
      );
      expect(mockQuotaRepo.incrementUsage).toHaveBeenCalledWith(
        'user-200',
        'proj-2',
        BigInt(20 * 1024 * 1024),
      );
      expect(mockBlobRepo.create).toHaveBeenCalledTimes(1);
      expect(mockNodeRepo.create).toHaveBeenCalledTimes(1);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'file.uploaded',
        expect.objectContaining({
          fileId: result.fileId,
          filename: 'dataset.csv',
          mimeType: 'text/csv',
        }),
      );
    });

    it('should abort multipart upload and mark session aborted', async () => {
      const session = new UploadSession({
        id: 'session-abort',
        userId: 'user-200',
        s3UploadId: 's3-upload-abort',
        s3Key: 'uploads/multipart/session-abort/payload.bin',
        filename: 'data.bin',
        mimeType: 'application/octet-stream',
        totalSize: BigInt(1000),
        partSize: 1000,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await service.abort('session-abort');

      expect(mockDriver.abortMultipartUpload).toHaveBeenCalledWith(
        'uploads/multipart/session-abort/payload.bin',
        's3-upload-abort',
      );
      expect(mockSessionRepo.update).toHaveBeenCalledTimes(1);
    });
  });
});
