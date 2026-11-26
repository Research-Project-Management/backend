import { BlobStatus, StorageBlobRecord, UploadSessionRecord, UploadSessionStatus } from '@/modules/files/types/files.type';
import { FilesFacade } from '@/modules/files/files.facade';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';
import { NodeRepository } from '@/modules/experiments/repositories/node.repository';
import { ExperimentsCacheService } from '@/modules/experiments/services/cache.service';
import { UploadService } from '@/modules/experiments/services/upload.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';

describe('Presigned & Resumable Multipart Upload Suite', () => {
  let mockDriver: jest.Mocked<IStorageAdapter>;
  let mockNodeRepo: jest.Mocked<NodeRepository>;
  let mockBlobRepo: jest.Mocked<BlobRepository>;
  let mockSessionRepo: jest.Mocked<SessionRepository>;
  let mockQuotaRepo: jest.Mocked<QuotaRepository>;
  let mockCache: jest.Mocked<ExperimentsCacheService>;
  let mockEvents: jest.Mocked<EventEmitter2>;

  beforeEach(() => {
    mockDriver = {
      put: jest.fn(),
      getStream: jest.fn().mockImplementation(async () => ({
        stream: Readable.from(['%PDF-1.7 mock-multipart-bytes']),
        contentLength: 29,
      })),
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
      applyLifecycleRules: jest.fn().mockResolvedValue(undefined),
      getLifecycleRules: jest.fn().mockResolvedValue([]),
    };

    mockNodeRepo = {
      findById: jest.fn(),
      create: jest.fn().mockImplementation(async (node) => node),
      update: jest.fn().mockImplementation(async (node) => node),
      delete: jest.fn(),
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
      findById: jest.fn(),
      findByHash: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(
        async (input) =>
          ({
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
          }) as StorageBlobRecord,
      ),
      delete: jest.fn(),
      incrementRefCount: jest.fn(),
      decrementRefCount: jest.fn(),
    } as unknown as jest.Mocked<BlobRepository>;

    mockSessionRepo = {
      create: jest.fn().mockImplementation(
        async (input) =>
          ({
            id: input.id,
            spaceId: input.spaceId,
            userId: input.userId,
            s3UploadId: input.s3UploadId,
            s3Key: input.s3Key,
            filename: input.filename,
            mimeType: input.mimeType,
            totalSize: input.totalSize,
            partSize: input.partSize,
            totalParts: Math.max(
              1,
              Math.ceil(Number(input.totalSize) / input.partSize),
            ),
            expectedHashHex: input.expectedHashHex ?? null,
            parentId: input.parentId ?? null,
            status: UploadSessionStatus.INITIALIZED,
            expiresAt: input.expiresAt,
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as UploadSessionRecord,
      ),
      findById: jest.fn(),
      markStatus: jest.fn().mockImplementation(
        async (id: string, status: UploadSessionStatus) =>
          ({
            id,
            spaceId: 'proj-2',
            userId: 'user-200',
            s3UploadId: 's3-upload-123',
            s3Key: `uploads/multipart/${id}/payload.csv`,
            filename: 'dataset.csv',
            mimeType: 'text/csv',
            totalSize: BigInt(20 * 1024 * 1024),
            partSize: 10 * 1024 * 1024,
            totalParts: 2,
            expectedHashHex: null,
            parentId: null,
            status,
            expiresAt: new Date(Date.now() + 3600000),
            createdAt: new Date(),
            updatedAt: new Date(),
          }) as UploadSessionRecord,
      ),
      markUploadingIfInitialized: jest.fn().mockResolvedValue(true),
      claimForFinalizing: jest.fn().mockResolvedValue(true),
      releaseFinalizingToUploading: jest.fn().mockResolvedValue(true),
      markCompletedWithBlob: jest
        .fn()
        .mockImplementation(async (id: string, blobId: string) => ({
          id,
          spaceId: 'proj-2',
          userId: 'user-200',
          s3UploadId: 's3-upload-123',
          s3Key: `uploads/multipart/${id}/payload.csv`,
          filename: 'dataset.csv',
          mimeType: 'text/csv',
          totalSize: BigInt(20 * 1024 * 1024),
          partSize: 10 * 1024 * 1024,
          totalParts: 2,
          expectedHashHex: null,
          parentId: null,
          status: UploadSessionStatus.COMPLETED,
          resultBlobId: blobId,
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      findExpiredSessions: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<SessionRepository>;

    mockQuotaRepo = {
      findBySpaceId: jest.fn(),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      incrementUsage: jest.fn().mockResolvedValue(0n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
    } as unknown as jest.Mocked<QuotaRepository>;

    mockCache = {
      invalidateFolder: jest.fn().mockResolvedValue(undefined),
      invalidateScopeTree: jest.fn().mockResolvedValue(undefined),
      getFolderListing: jest.fn().mockResolvedValue(null),
      setFolderListing: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockEvents = {
      emit: jest.fn(),
    } as any;
  });

  describe('UploadService (complete)', () => {
    let service: UploadService;

    beforeEach(() => {
      const blobService = new BlobService(mockDriver, mockBlobRepo);
      const uploadService = new FilesUploadService(
        mockDriver,
        blobService,
        mockBlobRepo,
        mockQuotaRepo,
        mockSessionRepo,
      );
      const filesPort = new FilesFacade(
        mockDriver,
        blobService,
        mockBlobRepo,
        mockQuotaRepo,
        uploadService,
      );
      service = new UploadService(
        filesPort,
        mockNodeRepo,
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

  describe('UploadService (multipart)', () => {
    let service: UploadService;

    beforeEach(() => {
      const blobService = new BlobService(mockDriver, mockBlobRepo);
      const uploadService = new FilesUploadService(
        mockDriver,
        blobService,
        mockBlobRepo,
        mockQuotaRepo,
        mockSessionRepo,
      );
      const filesPort = new FilesFacade(
        mockDriver,
        blobService,
        mockBlobRepo,
        mockQuotaRepo,
        uploadService,
      );
      service = new UploadService(
        filesPort,
        mockNodeRepo,
        mockCache,
        mockEvents,
      );
    });

    it('should initiate multipart upload session with dynamic chunk size', async () => {
      const result = await service.initiateMultipart({
        userId: 'user-200',
        filename: 'dataset.csv',
        mimeType: 'text/csv',
        totalSize: 50 * 1024 * 1024, // 50MB
        projectId: 'proj-2',
      });

      expect(mockDriver.initiateMultipartUpload).toHaveBeenCalledTimes(1);
      expect(mockSessionRepo.create).toHaveBeenCalledTimes(1);
      expect(result.sessionId).toBeDefined();
      expect(result.partSize).toBe(5 * 1024 * 1024); // 5MB R2 minimum base chunk size
      expect(result.totalParts).toBe(10);
    });

    it('should complete multipart upload, normalize parts, consume quota, and trigger BullMQ processing', async () => {
      const session: UploadSessionRecord = {
        id: 'session-123',
        userId: 'user-200',
        spaceId: 'proj-2',
        s3UploadId: 's3-upload-123',
        s3Key: 'uploads/multipart/session-123/payload.csv',
        filename: 'dataset.csv',
        mimeType: 'text/csv',
        totalSize: BigInt(20 * 1024 * 1024),
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expectedHashHex: null,
        parentId: null,
        status: UploadSessionStatus.INITIALIZED,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockSessionRepo.findById.mockResolvedValue(session);
      mockDriver.stat.mockResolvedValue({
        key: session.s3Key,
        size: 20 * 1024 * 1024,
        mimeType: 'text/csv',
        lastModified: new Date(),
      });

      const result = await service.completeMultipart({
        sessionId: 'session-123',
        parts: [
          { partNumber: 1, eTag: 'etag-part-1' },
          { partNumber: 2, eTag: 'etag-part-2' },
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
      const session: UploadSessionRecord = {
        id: 'session-abort',
        userId: 'user-200',
        spaceId: 'user-200',
        s3UploadId: 's3-upload-abort',
        s3Key: 'uploads/multipart/session-abort/payload.bin',
        filename: 'data.bin',
        mimeType: 'application/octet-stream',
        totalSize: BigInt(1000),
        partSize: 1000,
        totalParts: 1,
        expectedHashHex: null,
        parentId: null,
        status: UploadSessionStatus.INITIALIZED,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockSessionRepo.findById.mockResolvedValue(session);

      await service.abortMultipart('session-abort');

      expect(mockDriver.abortMultipartUpload).toHaveBeenCalledWith(
        'uploads/multipart/session-abort/payload.bin',
        's3-upload-abort',
      );
      expect(mockSessionRepo.markStatus).toHaveBeenCalledWith(
        'session-abort',
        UploadSessionStatus.ABORTED,
      );
    });
  });
});
