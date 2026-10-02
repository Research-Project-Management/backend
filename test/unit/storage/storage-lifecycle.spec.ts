import { S3StorageDriver } from '@/modules/storage/infrastructure/drivers/s3.driver';
import { LocalStorageDriver } from '@/modules/storage/infrastructure/drivers/local.driver';
import { TrashRetentionJob } from '@/modules/storage/application/jobs/trash-retention.cron';
import { MultipartCleanupJob } from '@/modules/storage/application/jobs/multipart-cleanup.cron';
import { OrphanBlobJob } from '@/modules/storage/application/jobs/orphan-blob.cron';
import { StorageLifecycleService } from '@/modules/storage/application/services/storage-lifecycle.service';
import { StorageQueueConsumer } from '@/modules/storage/application/queues/storage-queue.consumer';
import {
  STORAGE_JOB_MAINTENANCE_TRASH,
  STORAGE_JOB_MAINTENANCE_MULTIPART,
  STORAGE_JOB_MAINTENANCE_ORPHAN,
} from '@/modules/storage/application/queues/storage-queue.types';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { StorageBlob } from '@/modules/storage/domain/entities/storage-blob.entity';
import { ContentHash } from '@/modules/storage/domain/value-objects/content-hash.vo';
import { StorageKey } from '@/modules/storage/domain/value-objects/storage-key.vo';
import { UploadSession } from '@/modules/storage/domain/entities/upload-session.entity';
import {
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';

describe('Storage Lifecycle & Maintenance Pipeline Suite (Phase 4)', () => {
  describe('S3 & Local Storage Driver - Lifecycle Configuration', () => {
    let s3Driver: S3StorageDriver;
    let mockS3ClientSend: jest.Mock;

    beforeEach(() => {
      mockS3ClientSend = jest.fn();
      s3Driver = new S3StorageDriver({
        region: 'auto',
        bucket: 'flux-test-bucket',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret',
        },
      });
      (s3Driver as any).client = {
        send: mockS3ClientSend,
      };
    });

    it('should send PutBucketLifecycleConfigurationCommand with formatted rules', async () => {
      mockS3ClientSend.mockResolvedValue({});

      await s3Driver.applyLifecycleRules({
        rules: [
          {
            id: 'cleanup-temp-uploads',
            prefix: 'tmp/',
            status: 'Enabled',
            expirationDays: 1,
          },
          {
            id: 'abort-incomplete-multipart',
            prefix: '',
            status: 'Enabled',
            abortIncompleteMultipartUploadDays: 7,
          },
          {
            id: 'archive-cold-storage',
            prefix: 'archives/',
            status: 'Enabled',
            transitions: [
              { days: 90, storageClass: 'STANDARD_IA' },
              { days: 180, storageClass: 'GLACIER' },
            ],
          },
        ],
      });

      expect(mockS3ClientSend).toHaveBeenCalledWith(
        expect.any(PutBucketLifecycleConfigurationCommand),
      );
      const command = mockS3ClientSend.mock.calls[0][0];
      expect(command.input.Bucket).toBe('flux-test-bucket');
      expect(command.input.LifecycleConfiguration.Rules).toHaveLength(3);
      expect(command.input.LifecycleConfiguration.Rules[0].ID).toBe(
        'cleanup-temp-uploads',
      );
      expect(
        command.input.LifecycleConfiguration.Rules[1]
          .AbortIncompleteMultipartUpload.DaysAfterInitiation,
      ).toBe(7);
      expect(
        command.input.LifecycleConfiguration.Rules[2].Transitions,
      ).toHaveLength(2);
    });

    it('should retrieve and map lifecycle configuration from S3', async () => {
      mockS3ClientSend.mockResolvedValue({
        Rules: [
          {
            ID: 'cleanup-temp-uploads',
            Filter: { Prefix: 'tmp/' },
            Status: 'Enabled',
            Expiration: { Days: 1 },
          },
        ],
      });

      const config = await s3Driver.getLifecycleRules();
      expect(config).toBeDefined();
      expect(config?.rules).toHaveLength(1);
      expect(config?.rules[0].id).toBe('cleanup-temp-uploads');
      expect(config?.rules[0].expirationDays).toBe(1);
    });

    it('LocalStorageDriver should record and return active lifecycle rules', async () => {
      const localDriver = new LocalStorageDriver('./test-storage');
      await localDriver.applyLifecycleRules({
        rules: [
          {
            id: 'local-temp',
            prefix: 'tmp/',
            status: 'Enabled',
            expirationDays: 1,
          },
        ],
      });

      const config = await localDriver.getLifecycleRules();
      expect(config?.rules).toHaveLength(1);
      expect(config?.rules[0].id).toBe('local-temp');
    });
  });

  describe('TrashRetentionJob - Quota Rebalancing & Cascading Purge', () => {
    let job: TrashRetentionJob;
    let mockNodeRepo: any;
    let mockBlobRepo: any;
    let mockQuotaRepo: any;
    let mockCache: any;

    beforeEach(() => {
      mockNodeRepo = {
        findExpiredTrash: jest.fn(),
        findSubtreeNodes: jest.fn(),
        delete: jest.fn(),
      };
      mockBlobRepo = {
        findById: jest.fn(),
        update: jest.fn(),
      };
      mockQuotaRepo = {
        decrementUsage: jest.fn(),
      };
      mockCache = {
        invalidateFolder: jest.fn(),
      };

      job = new TrashRetentionJob(
        mockNodeRepo,
        mockBlobRepo,
        mockQuotaRepo,
        mockCache,
      );
    });

    it('should purge single expired file, decrement blob ref, reclaim quota, and invalidate cache', async () => {
      const expiredFile = new StorageNode({
        id: 'file-001',
        name: 'old-paper.pdf',
        isFolder: false,
        size: 1048576n, // 1MB
        blobId: 'blob-001',
        authorId: 'user-001',
        projectId: 'project-001',
      });

      const blob = new StorageBlob({
        id: 'blob-001',
        contentHash: ContentHash.fromHex('a'.repeat(64)),
        sizeBytes: 1048576n,
        s3Key: StorageKey.fromString('blobs/aa/test.pdf'),
        s3Bucket: 'flux',
        refCount: 2,
      });

      mockNodeRepo.findExpiredTrash.mockResolvedValue([expiredFile]);
      mockBlobRepo.findById.mockResolvedValue(blob);

      const result = await job.processExpiredTrash(30);

      expect(result.purgedCount).toBe(1);
      expect(result.reclaimedBytes).toBe(1048576n);
      expect(result.errors).toBe(0);

      // Verify blob ref decremented
      expect(blob.refCount).toBe(1);
      expect(mockBlobRepo.update).toHaveBeenCalledWith(blob);

      // Verify quota decremented
      expect(mockQuotaRepo.decrementUsage).toHaveBeenCalledWith(
        'user-001',
        'project-001',
        1048576n,
      );

      // Verify node deleted
      expect(mockNodeRepo.delete).toHaveBeenCalledWith('file-001');

      // Verify cache invalidated
      expect(mockCache.invalidateFolder).toHaveBeenCalled();
    });

    it('should perform cascading subtree purge for folders and reclaim quota for all child files', async () => {
      const expiredFolder = new StorageNode({
        id: 'folder-root',
        name: 'Research Experiment',
        isFolder: true,
        size: 0n,
        authorId: 'user-001',
      });

      const childFile = new StorageNode({
        id: 'file-child-01',
        name: 'dataset.csv',
        isFolder: false,
        size: 2048n,
        parentId: 'folder-root',
        blobId: 'blob-child-01',
        authorId: 'user-001',
      });

      const childBlob = new StorageBlob({
        id: 'blob-child-01',
        contentHash: ContentHash.fromHex('b'.repeat(64)),
        sizeBytes: 2048n,
        s3Key: StorageKey.fromString('blobs/bb/dataset.csv'),
        s3Bucket: 'flux',
        refCount: 1,
      });

      mockNodeRepo.findExpiredTrash.mockResolvedValue([expiredFolder]);
      mockNodeRepo.findSubtreeNodes.mockResolvedValue([
        expiredFolder,
        childFile,
      ]);
      mockBlobRepo.findById.mockResolvedValue(childBlob);

      const result = await job.processExpiredTrash(30);

      expect(result.purgedCount).toBe(2);
      expect(result.reclaimedBytes).toBe(2048n);

      // Child file deleted and parent folder deleted
      expect(mockNodeRepo.delete).toHaveBeenCalledWith('file-child-01');
      expect(mockNodeRepo.delete).toHaveBeenCalledWith('folder-root');
      expect(mockQuotaRepo.decrementUsage).toHaveBeenCalledWith(
        'user-001',
        null,
        2048n,
      );
    });
  });

  describe('MultipartCleanupJob - Abandoned Upload Sessions Abort', () => {
    let job: MultipartCleanupJob;
    let mockDriver: any;
    let mockSessionRepo: any;

    beforeEach(() => {
      mockDriver = {
        abortMultipartUpload: jest.fn(),
      };
      mockSessionRepo = {
        findExpiredSessions: jest.fn(),
        update: jest.fn(),
      };
      job = new MultipartCleanupJob(mockDriver, mockSessionRepo);
    });

    it('should abort abandoned multipart sessions in storage and mark aborted in DB', async () => {
      const expiredSession = new UploadSession({
        id: 'session-001',
        s3Key: 'multipart/test-large.bin',
        s3UploadId: 's3-upload-id-123',
        partSize: 5242880,
        totalParts: 4,
        filename: 'large.bin',
        totalSize: 20971520n,
        mimeType: 'application/octet-stream',
        userId: 'user-001',
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
      });

      mockSessionRepo.findExpiredSessions.mockResolvedValue([expiredSession]);

      const count = await job.processExpiredSessions();

      expect(count).toBe(1);
      expect(mockDriver.abortMultipartUpload).toHaveBeenCalledWith(
        'multipart/test-large.bin',
        's3-upload-id-123',
      );
      expect(expiredSession.status).toBe('ABORTED');
      expect(mockSessionRepo.update).toHaveBeenCalledWith(expiredSession);
    });
  });

  describe('OrphanBlobJob - Sweep Tombstoned CAS Blobs', () => {
    let job: OrphanBlobJob;
    let mockDriver: any;
    let mockBlobRepo: any;

    beforeEach(() => {
      mockDriver = {
        delete: jest.fn(),
      };
      mockBlobRepo = {
        findTombstonedBlobs: jest.fn(),
        delete: jest.fn(),
      };
      job = new OrphanBlobJob(mockDriver, mockBlobRepo);
    });

    it('should delete zero-reference tombstoned blobs from physical storage and DB', async () => {
      const deadBlob = new StorageBlob({
        id: 'dead-blob-001',
        contentHash: ContentHash.fromHex('c'.repeat(64)),
        sizeBytes: 4096n,
        s3Key: StorageKey.fromString('blobs/cc/orphan.pdf'),
        s3Bucket: 'flux',
        refCount: 0,
      });

      mockBlobRepo.findTombstonedBlobs.mockResolvedValue([deadBlob]);

      const count = await job.processTombstonedBlobs();

      expect(count).toBe(1);
      expect(mockDriver.delete).toHaveBeenCalledWith('blobs/cc/orphan.pdf');
      expect(mockBlobRepo.delete).toHaveBeenCalledWith('dead-blob-001');
    });
  });

  describe('StorageQueueConsumer - Maintenance Job Dispatching', () => {
    let consumer: StorageQueueConsumer;
    let mockDriver: any;
    let mockNodeRepo: any;
    let mockBlobRepo: any;
    let mockTrashJob: any;
    let mockMultipartJob: any;
    let mockOrphanJob: any;

    beforeEach(() => {
      mockDriver = { getStream: jest.fn() };
      mockNodeRepo = { findById: jest.fn(), update: jest.fn() };
      mockBlobRepo = { findById: jest.fn() };
      mockTrashJob = {
        processExpiredTrash: jest.fn().mockResolvedValue({ purgedCount: 3 }),
      };
      mockMultipartJob = {
        processExpiredSessions: jest.fn().mockResolvedValue(2),
      };
      mockOrphanJob = {
        processTombstonedBlobs: jest.fn().mockResolvedValue(1),
      };

      consumer = new StorageQueueConsumer(
        mockDriver,
        mockNodeRepo,
        mockBlobRepo,
        mockTrashJob,
        mockMultipartJob,
        mockOrphanJob,
      );
    });

    it('should dispatch to TrashRetentionJob when job name is maintenance-trash-retention', async () => {
      const res = await consumer.process({
        id: 'job-1',
        name: STORAGE_JOB_MAINTENANCE_TRASH,
        data: {},
      } as any);

      expect(mockTrashJob.processExpiredTrash).toHaveBeenCalled();
      expect(res).toEqual({ purgedCount: 3 });
    });

    it('should dispatch to MultipartCleanupJob when job name is maintenance-multipart-cleanup', async () => {
      const res = await consumer.process({
        id: 'job-2',
        name: STORAGE_JOB_MAINTENANCE_MULTIPART,
        data: {},
      } as any);

      expect(mockMultipartJob.processExpiredSessions).toHaveBeenCalled();
      expect(res).toBe(2);
    });

    it('should dispatch to OrphanBlobJob when job name is maintenance-orphan-blob', async () => {
      const res = await consumer.process({
        id: 'job-3',
        name: STORAGE_JOB_MAINTENANCE_ORPHAN,
        data: {},
      } as any);

      expect(mockOrphanJob.processTombstonedBlobs).toHaveBeenCalled();
      expect(res).toBe(1);
    });
  });

  describe('StorageLifecycleService - Bootstrap & Coordination', () => {
    let service: StorageLifecycleService;
    let mockDriver: any;
    let mockProducer: any;
    let mockTrashJob: any;
    let mockMultipartJob: any;
    let mockOrphanJob: any;

    beforeEach(() => {
      mockDriver = {
        applyLifecycleRules: jest.fn().mockResolvedValue(undefined),
        getLifecycleRules: jest.fn().mockResolvedValue({ rules: [] }),
      };
      mockProducer = {
        scheduleMaintenanceJobs: jest.fn().mockResolvedValue(undefined),
      };
      mockTrashJob = { processExpiredTrash: jest.fn() };
      mockMultipartJob = { processExpiredSessions: jest.fn() };
      mockOrphanJob = { processTombstonedBlobs: jest.fn() };

      service = new StorageLifecycleService(
        mockDriver,
        mockProducer,
        mockTrashJob,
        mockMultipartJob,
        mockOrphanJob,
      );
    });

    it('onApplicationBootstrap should initialize bucket rules and schedule maintenance in BullMQ', async () => {
      await service.onApplicationBootstrap();

      expect(mockDriver.applyLifecycleRules).toHaveBeenCalled();
      expect(mockProducer.scheduleMaintenanceJobs).toHaveBeenCalled();
    });
  });
});
