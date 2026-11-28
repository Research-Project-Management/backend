import { Readable } from 'node:stream';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { fromPartial } from '@total-typescript/shoehorn';
import { FilesFacade } from '@/modules/files/files.facade';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { QuotaRepository } from '@/modules/files/repositories/quota.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import type { IStorageAdapter } from '@/modules/files/types/adapter.type';
import {
  BlobStatus,
  type StorageBlobRecord,
  type UploadSessionRecord,
  UploadSessionStatus,
} from '@/modules/files/types/files.type';
import { NodeRepository } from '@/modules/experiments/repositories/node.repository';
import { ExperimentsCacheService } from '@/modules/experiments/services/cache.service';
import { UploadService } from '@/modules/experiments/services/upload.service';

describe('Experiments Presigned & Multipart Upload Security Suite', () => {
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
    mockDriver = fromPartial<jest.Mocked<IStorageAdapter>>({
      getStream: jest.fn(async () => ({
        stream: Readable.from(['%PDF-1.7 mock-multipart-bytes']),
        contentLength: 29,
      })),
      stat: jest.fn().mockResolvedValue({
        key: 'uploads/user-1/file.pdf',
        size: 5 * 1024 * 1024,
        mimeType: 'application/pdf',
        lastModified: new Date(),
      }),
      exists: jest.fn().mockResolvedValue(true),
      copy: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      initiateMultipartUpload: jest
        .fn()
        .mockResolvedValue({ uploadId: 's3-upload-test-id' }),
      getPresignedPartUploadUrl: jest
        .fn()
        .mockResolvedValue('https://s3.example.com/part-signed-url'),
      completeMultipartUpload: jest.fn().mockResolvedValue({ eTag: 'etag' }),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    });

    mockNodeRepo = fromPartial<jest.Mocked<NodeRepository>>({
      create: jest.fn(async (node) => node),
    });

    mockBlobRepo = fromPartial<jest.Mocked<BlobRepository>>({
      findByHash: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (input) => ({
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
      } satisfies StorageBlobRecord)),
    });

    mockSessionRepo = fromPartial<jest.Mocked<SessionRepository>>({
      create: jest.fn(async (input) =>
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
          totalParts: Math.max(
            1,
            Math.ceil(Number(input.totalSize) / input.partSize),
          ),
          expiresAt: input.expiresAt,
        }),
      ),
      findById: jest.fn(),
      markStatus: jest.fn(async (id: string, status: UploadSessionStatus) =>
        createTestSession({ id, status }),
      ),
      markUploadingIfInitialized: jest.fn().mockResolvedValue(true),
      claimForFinalizing: jest.fn().mockResolvedValue(true),
      releaseFinalizingToUploading: jest.fn().mockResolvedValue(true),
      markCompletedWithBlob: jest.fn(async (id: string, blobId: string) => ({
        ...createTestSession({ id, status: UploadSessionStatus.COMPLETED }),
        resultBlobId: blobId,
      })),
    });

    mockQuotaRepo = fromPartial<jest.Mocked<QuotaRepository>>({
      findBySpaceId: jest.fn().mockResolvedValue(null),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      incrementUsage: jest.fn().mockResolvedValue(0n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
    });

    mockCache = fromPartial<jest.Mocked<ExperimentsCacheService>>({
      invalidateFolder: jest.fn().mockResolvedValue(undefined),
    });
    mockEvents = fromPartial<jest.Mocked<EventEmitter2>>({ emit: jest.fn() });

    const blobService = new BlobService(mockDriver, mockBlobRepo);
    const filesPort = new FilesFacade(
      mockDriver,
      blobService,
      mockBlobRepo,
      mockQuotaRepo,
      new FilesUploadService(
        mockDriver,
        blobService,
        mockBlobRepo,
        mockQuotaRepo,
        mockSessionRepo,
      ),
    );
    service = new UploadService(filesPort, mockNodeRepo, mockCache, mockEvents);
  });

  describe('Presigned complete', () => {
    it('completes presigned upload, consumes quota, persists node/blob, and emits file.uploaded', async () => {
      const result = await service.complete({
        userId: ownerId,
        storageKey: `uploads/${ownerId}/paper.pdf`,
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        projectId,
      });

      expect(result.size).toBe(5 * 1024 * 1024);
      expect(mockQuotaRepo.incrementUsage).toHaveBeenCalledWith(
        projectId,
        BigInt(5 * 1024 * 1024),
      );
      expect(mockCache.invalidateFolder).toHaveBeenCalledWith(projectId, null);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'file.uploaded',
        expect.objectContaining({
          fileId: result.fileId,
          filename: 'paper.pdf',
          mimeType: 'application/pdf',
        }),
      );
    });

    it('rejects dangerous executable extensions and missing physical objects', async () => {
      await expect(
        service.complete({
          userId: ownerId,
          storageKey: `uploads/${ownerId}/virus.exe`,
          filename: 'virus.exe',
        }),
      ).rejects.toThrow(BadRequestException);

      mockDriver.stat.mockRejectedValueOnce(new Error('Object not found'));
      await expect(
        service.complete({
          userId: ownerId,
          storageKey: `uploads/${ownerId}/missing.pdf`,
          filename: 'missing.pdf',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Multipart initiate & getMultipartPartUrl BOLA/State Guards', () => {
    it('initiates multipart sessions and allows owner or matching project collaborator to sign part URLs', async () => {
      const init = await service.initiateMultipart({
        userId: ownerId,
        filename: 'dataset.csv',
        mimeType: 'text/csv',
        totalSize: 50 * 1024 * 1024,
        projectId,
      });
      expect(init.partSize).toBe(5 * 1024 * 1024);
      expect(init.totalParts).toBe(10);

      const session = createTestSession();
      mockSessionRepo.findById.mockResolvedValue(session);

      await expect(
        service.getMultipartPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).resolves.toBe('https://s3.example.com/part-signed-url');

      await expect(
        service.getMultipartPartUrl('session-valid-1', 2, {
          userId: 'collab-user-888',
          projectId,
        }),
      ).resolves.toBe('https://s3.example.com/part-signed-url');
    });

    it('rejects attacker BOLA, out-of-bounds part numbers, and expired/completed/aborted sessions', async () => {
      mockSessionRepo.findById.mockResolvedValue(
        createTestSession({ totalParts: 3 }),
      );

      await expect(
        service.getMultipartPartUrl('session-valid-1', 1, {
          userId: attackerId,
        }),
      ).rejects.toThrow(NotFoundException);

      for (const badPart of [0, 4, 1.5]) {
        await expect(
          service.getMultipartPartUrl('session-valid-1', badPart, {
            userId: ownerId,
          }),
        ).rejects.toThrow(BadRequestException);
      }

      mockSessionRepo.findById.mockResolvedValueOnce(
        createTestSession({ expiresAt: new Date(Date.now() - 60_000) }),
      );
      await expect(
        service.getMultipartPartUrl('session-valid-1', 1, { userId: ownerId }),
      ).rejects.toThrow(NotFoundException);

      for (const terminalStatus of [
        UploadSessionStatus.COMPLETED,
        UploadSessionStatus.ABORTED,
      ]) {
        mockSessionRepo.findById.mockResolvedValueOnce(
          createTestSession({ status: terminalStatus }),
        );
        await expect(
          service.getMultipartPartUrl('session-valid-1', 1, {
            userId: ownerId,
          }),
        ).rejects.toThrow(BadRequestException);
      }
    });
  });

  describe('Multipart complete & abort BOLA/Idempotency Guards', () => {
    it('completes multipart upload for rightful owner and blocks unauthorized actors, double-complete, aborted sessions, and empty parts', async () => {
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
      expect(mockQuotaRepo.incrementUsage).toHaveBeenCalledWith(
        projectId,
        session.totalSize,
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'file.uploaded',
        expect.objectContaining({ fileId: result.fileId }),
      );

      // Unauthorized actor BOLA
      mockDriver.completeMultipartUpload.mockClear();
      await expect(
        service.completeMultipart({
          sessionId: 'session-valid-1',
          parts: [{ partNumber: 1, eTag: 'etag-1' }],
          actor: { userId: attackerId },
        }),
      ).rejects.toThrow(NotFoundException);

      // Empty parts
      await expect(
        service.completeMultipart({
          sessionId: 'session-valid-1',
          parts: [],
          actor: { userId: ownerId },
        }),
      ).rejects.toThrow(BadRequestException);

      // Double-complete & aborted session guards
      for (const status of [
        UploadSessionStatus.COMPLETED,
        UploadSessionStatus.ABORTED,
      ]) {
        mockSessionRepo.findById.mockResolvedValueOnce(
          createTestSession({ status }),
        );
        await expect(
          service.completeMultipart({
            sessionId: 'session-valid-1',
            parts: [{ partNumber: 1, eTag: 'etag-1' }],
            actor: { userId: ownerId },
          }),
        ).rejects.toThrow(BadRequestException);
      }
      expect(mockDriver.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts active sessions for rightful owner, blocks attackers and completed sessions, and treats repeat abort as idempotent', async () => {
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

      mockDriver.abortMultipartUpload.mockClear();
      await expect(
        service.abortMultipart('session-valid-1', { userId: attackerId }),
      ).rejects.toThrow(NotFoundException);

      mockSessionRepo.findById.mockResolvedValueOnce(
        createTestSession({ status: UploadSessionStatus.COMPLETED }),
      );
      await expect(
        service.abortMultipart('session-valid-1', { userId: ownerId }),
      ).rejects.toThrow(BadRequestException);

      mockSessionRepo.findById.mockResolvedValueOnce(
        createTestSession({ status: UploadSessionStatus.ABORTED }),
      );
      await service.abortMultipart('session-valid-1', { userId: ownerId });
      expect(mockDriver.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
