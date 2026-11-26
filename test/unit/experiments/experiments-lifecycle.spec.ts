import { BlobStatus, StorageBlobRecord } from '@/modules/files/types/files.type';
import { FilesFacade } from '@/modules/files/files.facade';
import { LocalStorageAdapter } from '@/modules/files/adapters/local.adapter';
import { S3StorageAdapter } from '@/modules/files/adapters/s3.adapter';
import { supportsBucketLifecycle } from '@/modules/files/types/adapter.type';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { SessionRepository } from '@/modules/files/repositories/session.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import { FilesUploadService } from '@/modules/files/services/upload.service';
import { ExperimentNode } from '@/modules/experiments/domain/node.domain';
import { TrashService } from '@/modules/experiments/services/trash.service';
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

describe('Storage Lifecycle & Maintenance Pipeline Suite (Phase 4)', () => {
  describe('S3 & Local Storage Driver - Lifecycle Configuration', () => {
    let s3Driver: S3StorageAdapter;
    let mockS3ClientSend: jest.Mock;

    beforeEach(() => {
      mockS3ClientSend = jest.fn();
      s3Driver = new S3StorageAdapter({
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

    it('LocalStorageAdapter does not expose bucket lifecycle capability (no fake stub)', () => {
      const localDriver = new LocalStorageAdapter('./test-storage');
      expect(supportsBucketLifecycle(localDriver)).toBe(false);
      expect(
        supportsBucketLifecycle(
          new S3StorageAdapter({
            region: 'auto',
            bucket: 'b',
            credentials: { accessKeyId: 'a', secretAccessKey: 's' },
          }),
        ),
      ).toBe(true);
    });
  });

  describe('TrashService.processExpiredTrash - Quota Rebalancing & Cascading Purge', () => {
    let trashService: TrashService;
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
        incrementRefCount: jest.fn(),
        decrementRefCount: jest.fn(),
      };
      mockQuotaRepo = {
        decrementUsage: jest.fn(),
      };
      mockCache = {
        invalidateFolder: jest.fn(),
      };

      const blobService = new BlobService({} as any, mockBlobRepo);
      const filesPort = new FilesFacade(
        {} as any,
        blobService,
        mockBlobRepo as BlobRepository,
        mockQuotaRepo,
        new FilesUploadService(
          {} as any,
          blobService,
          mockBlobRepo as BlobRepository,
          mockQuotaRepo,
          {} as SessionRepository,
        ),
      );
      trashService = new TrashService(
        mockNodeRepo,
        filesPort,
        mockCache,
        { emit: jest.fn() } as any,
        {
          findByFileId: jest.fn().mockResolvedValue([]),
          deleteByFileId: jest.fn(),
        } as any,
      );
    });

    it('should purge single expired file, decrement blob ref, reclaim quota, and invalidate cache', async () => {
      const expiredFile = new ExperimentNode({
        id: 'file-001',
        name: 'old-paper.pdf',
        isFolder: false,
        size: 1048576n, // 1MB
        blobId: 'blob-001',
        authorId: 'user-001',
        projectId: 'project-001',
      });

      const blob: StorageBlobRecord = {
        id: 'blob-001',
        contentHashHex: ContentHash.fromHex('a'.repeat(64)).toHex(),
        hashAlgorithm: 'SHA256',
        sizeBytes: 1048576n,
        mimeType: 'application/pdf',
        checksumVerified: true,
        s3Key: StorageKey.fromString('blobs/aa/test.pdf').value(),
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        status: BlobStatus.READY,
        refCount: 2,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      };

      mockNodeRepo.findExpiredTrash.mockResolvedValue([expiredFile]);
      mockBlobRepo.findById.mockResolvedValue(blob);

      const result = await trashService.processExpiredTrash(30);

      expect(result.purgedCount).toBe(1);
      expect(result.reclaimedBytes).toBe(1048576n);
      expect(result.errors).toBe(0);

      expect(mockBlobRepo.decrementRefCount).toHaveBeenCalledWith('blob-001');

      // Verify quota decremented
      expect(mockQuotaRepo.decrementUsage).toHaveBeenCalledWith(
        'project-001',
        1048576n,
      );

      // Verify node deleted
      expect(mockNodeRepo.delete).toHaveBeenCalledWith('file-001');

      // Verify cache invalidated
      expect(mockCache.invalidateFolder).toHaveBeenCalled();
    });

    it('should perform cascading subtree purge for folders and reclaim quota for all child files', async () => {
      const expiredFolder = new ExperimentNode({
        id: 'folder-root',
        name: 'Research Experiment',
        isFolder: true,
        size: 0n,
        authorId: 'user-001',
      });

      const childFile = new ExperimentNode({
        id: 'file-child-01',
        name: 'dataset.csv',
        isFolder: false,
        size: 2048n,
        parentId: 'folder-root',
        blobId: 'blob-child-01',
        authorId: 'user-001',
      });

      const childBlob: StorageBlobRecord = {
        id: 'blob-child-01',
        contentHashHex: ContentHash.fromHex('b'.repeat(64)).toHex(),
        hashAlgorithm: 'SHA256',
        sizeBytes: 2048n,
        mimeType: 'text/csv',
        checksumVerified: true,
        s3Key: StorageKey.fromString('blobs/bb/dataset.csv').value(),
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        status: BlobStatus.READY,
        refCount: 1,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      };

      mockNodeRepo.findExpiredTrash.mockResolvedValue([expiredFolder]);
      mockNodeRepo.findSubtreeNodes.mockResolvedValue([
        expiredFolder,
        childFile,
      ]);
      mockBlobRepo.findById.mockResolvedValue(childBlob);

      const result = await trashService.processExpiredTrash(30);

      expect(result.purgedCount).toBe(2);
      expect(result.reclaimedBytes).toBe(2048n);

      // Child file deleted and parent folder deleted
      expect(mockNodeRepo.delete).toHaveBeenCalledWith('file-child-01');
      expect(mockNodeRepo.delete).toHaveBeenCalledWith('folder-root');
      expect(mockQuotaRepo.decrementUsage).toHaveBeenCalledWith(
        'user-001',
        2048n,
      );
    });
  });

  describe('BlobService.reclaimOrphanBlobs - Sweep Tombstoned CAS Blobs', () => {
    let blobService: BlobService;
    let mockDriver: any;
    let mockBlobRepo: any;

    beforeEach(() => {
      mockDriver = {
        delete: jest.fn(),
      };
      mockBlobRepo = {
        reclaimStuckClaims: jest.fn().mockResolvedValue(0),
        claimOrphanBlobsBatch: jest.fn().mockResolvedValue([]),
        restoreClaimedBlob: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn(),
      };
      blobService = new BlobService(mockDriver, mockBlobRepo);
    });

    it('should delete zero-reference tombstoned blobs from physical storage and DB', async () => {
      const deadBlob: StorageBlobRecord = {
        id: 'dead-blob-001',
        contentHashHex: ContentHash.fromHex('c'.repeat(64)).toHex(),
        hashAlgorithm: 'SHA256',
        sizeBytes: 4096n,
        mimeType: 'application/pdf',
        checksumVerified: true,
        s3Key: StorageKey.fromString('blobs/cc/orphan.pdf').value(),
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        refCount: 0,
        status: BlobStatus.DELETED,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      };

      mockBlobRepo.claimOrphanBlobsBatch.mockResolvedValueOnce([deadBlob]);

      const count = await blobService.reclaimOrphanBlobs();

      expect(count).toBe(1);
      expect(mockDriver.delete).toHaveBeenCalledWith('blobs/cc/orphan.pdf');
      expect(mockBlobRepo.delete).toHaveBeenCalledWith('dead-blob-001');
    });
  });
});
