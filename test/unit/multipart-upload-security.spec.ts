import { MultipartUploadUseCase } from '@/modules/storage/application/use-cases/upload/multipart-upload.use-case';
import { IStorageDriver } from '@/modules/storage/domain/ports/storage-driver.port';
import { IStorageNodeRepository } from '@/modules/storage/domain/ports/storage-node.repository.port';
import { IStorageBlobRepository } from '@/modules/storage/domain/ports/storage-blob.repository.port';
import { IUploadSessionRepository } from '@/modules/storage/domain/ports/upload-session.repository.port';
import { IStorageQuotaRepository } from '@/modules/storage/domain/ports/storage-quota.repository.port';
import { StorageRedisCacheService } from '@/modules/storage/infrastructure/cache/storage-redis-cache.service';
import {
  UploadSession,
  UploadSessionStatus,
} from '@/modules/storage/domain/entities/upload-session.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('Multipart Upload BOLA/IDOR Hardening Suite', () => {
  let useCase: MultipartUploadUseCase;
  let mockDriver: jest.Mocked<IStorageDriver>;
  let mockNodeRepo: jest.Mocked<IStorageNodeRepository>;
  let mockBlobRepo: jest.Mocked<IStorageBlobRepository>;
  let mockSessionRepo: jest.Mocked<IUploadSessionRepository>;
  let mockQuotaRepo: jest.Mocked<IStorageQuotaRepository>;
  let mockCache: jest.Mocked<StorageRedisCacheService>;
  let mockEvents: jest.Mocked<EventEmitter2>;

  const ownerId = 'user-owner-123';
  const attackerId = 'user-attacker-666';
  const projectId = 'proj-research-999';

  const createTestSession = (
    overrides?: Partial<ConstructorParameters<typeof UploadSession>[0]>,
  ) => {
    return new UploadSession({
      id: 'session-valid-1',
      userId: ownerId,
      projectId: projectId,
      s3UploadId: 's3-upload-test-id',
      s3Key: 'uploads/multipart/session-valid-1/payload.bin',
      filename: 'large_dataset.bin',
      mimeType: 'application/octet-stream',
      totalSize: BigInt(30 * 1024 * 1024),
      partSize: 10 * 1024 * 1024,
      totalParts: 3,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      status: UploadSessionStatus.INITIALIZED,
      ...overrides,
    });
  };

  beforeEach(() => {
    mockDriver = {
      put: jest.fn(),
      getStream: jest.fn(),
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
      findByScope: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      incrementUsage: jest.fn().mockResolvedValue(0n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
      reconcileUsage: jest.fn().mockResolvedValue(undefined),
    };

    mockCache = {
      invalidateFolder: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockEvents = {
      emit: jest.fn(),
    } as any;

    useCase = new MultipartUploadUseCase(
      mockDriver,
      mockNodeRepo,
      mockBlobRepo,
      mockSessionRepo,
      mockQuotaRepo,
      mockCache,
      mockEvents,
    );
  });

  describe('getPartUrl (Phase 2)', () => {
    it('should generate signed part URL for the rightful owner', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      const url = await useCase.getPartUrl('session-valid-1', 1, {
        userId: ownerId,
      });

      expect(url).toBe('https://s3.example.com/part-signed-url');
      expect(mockDriver.getPresignedPartUploadUrl).toHaveBeenCalledWith(
        session.s3Key,
        session.s3UploadId,
        1,
        3600,
      );
      expect(mockSessionRepo.update).toHaveBeenCalled();
    });

    it('should allow project member with matching projectId to get part URL', async () => {
      const session = createTestSession({ userId: ownerId, projectId });
      mockSessionRepo.findById.mockResolvedValue(session);

      const url = await useCase.getPartUrl('session-valid-1', 2, {
        userId: 'collab-user-888',
        projectId,
      });

      expect(url).toBe('https://s3.example.com/part-signed-url');
    });

    it('should throw NotFoundException (anti-BOLA) when attacker requests part URL of another user session', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.getPartUrl('session-valid-1', 1, { userId: attackerId }),
      ).rejects.toThrow(NotFoundException);

      expect(mockDriver.getPresignedPartUploadUrl).not.toHaveBeenCalled();
    });

    it('should reject out-of-bounds part numbers (< 1 or > totalParts)', async () => {
      const session = createTestSession({ totalParts: 3 });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.getPartUrl('session-valid-1', 0, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        useCase.getPartUrl('session-valid-1', 4, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        useCase.getPartUrl('session-valid-1', 1.5, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject getPartUrl if session is expired', async () => {
      const session = createTestSession({
        expiresAt: new Date(Date.now() - 60000), // Expired 1 min ago
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.getPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject getPartUrl if session is already completed', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.COMPLETED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.getPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject getPartUrl if session is already aborted', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.ABORTED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.getPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('complete (Phase 3)', () => {
    it('should complete upload for rightful owner and create storage node and blob', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      const result = await useCase.complete({
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
        ownerId,
        projectId,
        session.totalSize,
      );
      expect(mockBlobRepo.create).toHaveBeenCalledTimes(1);
      expect(mockNodeRepo.create).toHaveBeenCalledTimes(1);
      expect(session.status).toBe(UploadSessionStatus.COMPLETED);
    });

    it('should throw NotFoundException when unauthorized actor attempts to complete another user session', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.complete({
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
        useCase.complete({
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
        useCase.complete({
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
        useCase.complete({
          sessionId: 'session-valid-1',
          parts: [],
          actor: { userId: ownerId },
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('abort (Session Cleanup)', () => {
    it('should abort multipart upload for rightful owner and update session status', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await useCase.abort('session-valid-1', { userId: ownerId });

      expect(mockDriver.abortMultipartUpload).toHaveBeenCalledWith(
        session.s3Key,
        session.s3UploadId,
      );
      expect(session.status).toBe(UploadSessionStatus.ABORTED);
      expect(mockSessionRepo.update).toHaveBeenCalled();
    });

    it('should throw NotFoundException when unauthorized attacker tries to abort session', async () => {
      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.abort('session-valid-1', { userId: attackerId }),
      ).rejects.toThrow(NotFoundException);

      expect(mockDriver.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject abort on an already completed session', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.COMPLETED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        useCase.abort('session-valid-1', { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);

      expect(mockDriver.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('should be idempotent if session is already aborted', async () => {
      const session = createTestSession({
        status: UploadSessionStatus.ABORTED,
      });
      mockSessionRepo.findById.mockResolvedValue(session);

      await useCase.abort('session-valid-1', { userId: ownerId });

      expect(mockDriver.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
