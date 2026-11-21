import {
  BlobStatus,
  FilesFacade,
  StorageBlobRecord,
  UploadSessionRecord,
  UploadSessionStatus,
} from '@/modules/files';
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

describe('Multipart Upload BOLA/IDOR Hardening Suite', () => {
  let service: UploadService;
  let mockDriver: jest.Mocked<IStorageAdapter>;
  let mockNodeRepo: jest.Mocked<NodeRepository>;
  let mockBlobRepo: jest.Mocked<BlobRepository>;
  let mockSessionRepo: jest.Mocked<SessionRepository>;
  let mockQuotaRepo: jest.Mocked<QuotaRepository>;
  let mockCache: jest.Mocked<ExperimentsCacheService>;
  let mockEvents: jest.Mocked<EventEmitter2>;

  const ownerId = 'user-owner-123';
  const attackerId = 'user-attacker-666';
  const projectId = 'proj-research-999';

  const createTestSession = (
    overrides?: Partial<UploadSessionRecord>,
  ): UploadSessionRecord => ({
    id: 'session-valid-1',
    userId: ownerId,
    spaceId: projectId,
    s3UploadId: 's3-upload-test-id',
    s3Key: 'uploads/multipart/session-valid-1/payload.bin',
    filename: 'large_dataset.bin',
    mimeType: 'application/octet-stream',
    totalSize: BigInt(30 * 1024 * 1024),
    partSize: 10 * 1024 * 1024,
    totalParts: 3,
    expectedHashHex: null,
    parentId: null,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    status: UploadSessionStatus.INITIALIZED,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    mockDriver = {
      put: jest.fn(),
      getStream: jest.fn().mockImplementation(async () => ({
        stream: Readable.from(['mock-binary-payload']),
        contentLength: 19,
      })),
      stat: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      exists: jest.fn(),
      copy: jest.fn(),
      getPresignedUploadUrl: jest.fn(),
      getPresignedDownloadUrl: jest.fn(),
      initiateMultipartUpload: jest
        .fn()
        .mockResolvedValue({ uploadId: 's3-upload-test-id' }),
      getPresignedPartUploadUrl: jest
        .fn()
        .mockResolvedValue('https://s3.example.com/part-signed-url'),
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
      create: jest.fn().mockImplementation(async (input) =>
        createTestSession({
          id: input.id,
          userId: input.userId,
          spaceId: input.spaceId,
          s3UploadId: input.s3UploadId,
          s3Key: input.s3Key,
          filename: input.filename,
          mimeType: input.mimeType,
          totalSize: input.totalSize,
          partSize: input.partSize,
          expiresAt: input.expiresAt,
        }),
      ),
      findById: jest.fn(),
      markStatus: jest
        .fn()
        .mockImplementation(async (id: string, status: UploadSessionStatus) =>
          createTestSession({ id, status }),
        ),
      markUploadingIfInitialized: jest.fn().mockResolvedValue(true),
      claimForFinalizing: jest.fn().mockResolvedValue(true),
      releaseFinalizingToUploading: jest.fn().mockResolvedValue(true),
      markCompletedWithBlob: jest
        .fn()
        .mockImplementation(async (id: string, blobId: string) => ({
          ...createTestSession({ id, status: UploadSessionStatus.COMPLETED }),
          resultBlobId: blobId,
        })),
      findExpiredSessions: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<SessionRepository>;

    mockQuotaRepo = {
      findBySpaceId: jest.fn().mockResolvedValue(null),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      incrementUsage: jest.fn().mockResolvedValue(0n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
    } as unknown as jest.Mocked<QuotaRepository>;

    mockCache = {
      invalidateFolder: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockEvents = {
      emit: jest.fn(),
    } as any;

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
    service = new UploadService(filesPort, mockNodeRepo, mockCache, mockEvents);
  });

  describe('getMultipartPartUrl (Phase 2)', () => {
    it('should generate signed part URL for the rightful owner', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      const url = await service.getMultipartPartUrl('session-valid-1', 1, {
        userId: ownerId,
      });

      expect(url).toBe('https://s3.example.com/part-signed-url');
      expect(mockDriver.getPresignedPartUploadUrl).toHaveBeenCalledWith(
        session.s3Key,
        session.s3UploadId,
        1,
        3600,
      );
      expect(mockSessionRepo.markUploadingIfInitialized).toHaveBeenCalledWith(
        'session-valid-1',
      );
    });

    it('should allow project member with matching projectId to get part URL', async () => {
      const session = createTestSession({
        userId: ownerId,
        spaceId: projectId,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      const url = await service.getMultipartPartUrl('session-valid-1', 2, {
        userId: 'collab-user-888',
        projectId,
      });

      expect(url).toBe('https://s3.example.com/part-signed-url');
    });

    it('should throw NotFoundException (anti-BOLA) when attacker requests part URL of another user session', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 1, {
          userId: attackerId,
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockDriver.getPresignedPartUploadUrl).not.toHaveBeenCalled();
    });

    it('should reject out-of-bounds part numbers (< 1 or > totalParts)', async () => {
      const session = createTestSession({ totalParts: 3 });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 0, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 4, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 1.5, {
          userId: ownerId,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject getMultipartPartUrl if session is expired', async () => {
      const session = createTestSession({
        expiresAt: new Date(Date.now() - 60000),
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject getMultipartPartUrl if session is already completed', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.COMPLETED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject getMultipartPartUrl if session is already aborted', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.ABORTED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('completeMultipart (Phase 3)', () => {
    it('should complete upload for rightful owner and create storage node and blob', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);
      mockDriver.stat.mockResolvedValue({
        key: session.s3Key,
        size: Number(session.totalSize),
        mimeType: session.mimeType,
        lastModified: new Date(),
      });

      const result = await service.completeMultipart({
        sessionId: 'session-valid-1',
        parts: [
          { partNumber: 1, eTag: 'etag-1' },
          { partNumber: 2, eTag: 'etag-2' },
          { partNumber: 3, eTag: 'etag-3' },
        ],
        actor: { userId: ownerId },
      });

      expect(result.fileId).toBeDefined();
      expect(result.blobId).toBeDefined();
      expect(mockDriver.completeMultipartUpload).toHaveBeenCalledTimes(1);
      expect(mockQuotaRepo.incrementUsage).toHaveBeenCalledWith(
        projectId,
        session.totalSize,
      );
      expect(mockBlobRepo.create).toHaveBeenCalledTimes(1);
      expect(mockNodeRepo.create).toHaveBeenCalledTimes(1);
      expect(mockSessionRepo.markCompletedWithBlob).toHaveBeenCalledWith(
        'session-valid-1',
        result.blobId,
      );
    });

    it('should throw NotFoundException when unauthorized actor attempts to complete another user session', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.completeMultipart({
          sessionId: 'session-valid-1',
          parts: [{ partNumber: 1, eTag: 'etag-1' }],
          actor: { userId: attackerId },
        }),
      ).rejects.toThrow(NotFoundException);

      expect(mockDriver.completeMultipartUpload).not.toHaveBeenCalled();
      expect(mockQuotaRepo.incrementUsage).not.toHaveBeenCalled();
    });

    it('should prevent double-complete and double quota consumption (idempotency guard)', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.COMPLETED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.completeMultipart({
          sessionId: 'session-valid-1',
          parts: [{ partNumber: 1, eTag: 'etag-1' }],
          actor: { userId: ownerId },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockDriver.completeMultipartUpload).not.toHaveBeenCalled();
      expect(mockQuotaRepo.incrementUsage).not.toHaveBeenCalled();
      expect(mockBlobRepo.create).not.toHaveBeenCalled();
    });

    it('should reject completion of an aborted session', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.ABORTED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.completeMultipart({
          sessionId: 'session-valid-1',
          parts: [{ partNumber: 1, eTag: 'etag-1' }],
          actor: { userId: ownerId },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject completion with empty parts array', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.completeMultipart({
          sessionId: 'session-valid-1',
          parts: [],
          actor: { userId: ownerId },
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('abortMultipart (Session Cleanup)', () => {
    it('should abort multipart upload for rightful owner and update session status', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await service.abortMultipart('session-valid-1', { userId: ownerId });

      expect(mockDriver.abortMultipartUpload).toHaveBeenCalledWith(
        session.s3Key,
        session.s3UploadId,
      );
      expect(mockSessionRepo.markStatus).toHaveBeenCalledWith(
        'session-valid-1',
        UploadSessionStatus.ABORTED,
      );
    });

    it('should throw NotFoundException when unauthorized attacker tries to abort session', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.abortMultipart('session-valid-1', { userId: attackerId }),
      ).rejects.toThrow(NotFoundException);

      expect(mockDriver.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject abort on an already completed session', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.COMPLETED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.abortMultipart('session-valid-1', { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);

      expect(mockDriver.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should be idempotent if session is already aborted', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.ABORTED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await service.abortMultipart('session-valid-1', { userId: ownerId });

      expect(mockDriver.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
