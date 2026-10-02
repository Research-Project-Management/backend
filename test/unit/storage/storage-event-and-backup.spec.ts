import { StorageEventOutboxService } from '@/modules/storage/application/services/storage-event-outbox.service';
import { StorageBackupService } from '@/modules/storage/application/services/storage-backup.service';
import { FileUploadedEvent } from '@/modules/storage/domain/events/file-uploaded.event';
import { FileDownloadedEvent } from '@/modules/storage/domain/events/file-downloaded.event';
import { FileDeletedEvent } from '@/modules/storage/domain/events/file-deleted.event';
import { FileTrashedEvent } from '@/modules/storage/domain/events/file-trashed.event';
import { QuotaExceededEvent } from '@/modules/storage/domain/events/quota-exceeded.event';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { StorageBlob } from '@/modules/storage/domain/entities/storage-blob.entity';
import { ContentHash } from '@/modules/storage/domain/value-objects/content-hash.vo';
import { StorageKey } from '@/modules/storage/domain/value-objects/storage-key.vo';
import { Readable } from 'stream';

describe('Storage Event-Driven Outbox & Automated Backup Pipeline Suite (Phase 5)', () => {
  describe('StorageEventOutboxService - Durable Streams & PubSub', () => {
    let outboxService: StorageEventOutboxService;
    let mockRedisClient: any;
    let mockRedisService: any;

    beforeEach(() => {
      mockRedisClient = {
        publish: jest.fn().mockResolvedValue(1),
        xadd: jest.fn().mockResolvedValue('1700000000000-0'),
      };
      mockRedisService = {
        getClient: jest.fn().mockReturnValue(mockRedisClient),
        isReady: jest.fn().mockReturnValue(true),
      };
      outboxService = new StorageEventOutboxService(mockRedisService);
    });

    it('should dispatch file.uploaded event to Redis Stream and PubSub channel', async () => {
      const event = new FileUploadedEvent(
        'file-001',
        'blob-001',
        'user-123',
        'dataset.csv',
        'text/csv',
        1024n,
        'blobs/aa/test.csv',
        'project-abc',
      );

      await outboxService.handleFileUploaded(event);

      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        'flux:storage:events',
        expect.stringContaining('file.uploaded'),
      );
      expect(mockRedisClient.xadd).toHaveBeenCalledWith(
        'flux:storage:stream',
        'MAXLEN',
        '~',
        '10000',
        '*',
        'eventId',
        expect.any(String),
        'type',
        'file.uploaded',
        'data',
        expect.stringContaining('dataset.csv'),
      );

      const recent = outboxService.getRecentEvents();
      expect(recent).toHaveLength(1);
      expect(recent[0].type).toBe('file.uploaded');
      expect(recent[0].payload.fileId).toBe('file-001');
    });

    it('should dispatch file.downloaded audit event', async () => {
      const event = new FileDownloadedEvent(
        'file-002',
        'paper.pdf',
        'application/pdf',
        2048,
        'user-456',
        '192.168.1.1',
      );

      await outboxService.handleFileDownloaded(event);

      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        'flux:storage:events',
        expect.stringContaining('file.downloaded'),
      );
      const recent = outboxService.getRecentEvents();
      expect(recent[0].type).toBe('file.downloaded');
      expect(recent[0].payload.accessedBy).toBe('user-456');
    });

    it('should dispatch file.deleted and quota.exceeded events', async () => {
      await outboxService.handleFileDeleted(
        new FileDeletedEvent(
          'file-003',
          'blob-003',
          'user-123',
          'project-abc',
          true,
        ),
      );
      await outboxService.handleQuotaExceeded(
        new QuotaExceededEvent(
          'user-123',
          'project-abc',
          1024n,
          5368709120n,
          5368709120n,
        ),
      );

      const recent = outboxService.getRecentEvents();
      expect(recent.some((e) => e.type === 'file.deleted')).toBe(true);
      expect(recent.some((e) => e.type === 'quota.exceeded')).toBe(true);
    });

    it('should gracefully fallback and maintain memory history when Redis is unavailable', async () => {
      const fallbackOutbox = new StorageEventOutboxService(undefined);

      await fallbackOutbox.handleFileTrashed(
        new FileTrashedEvent('file-004', 'user-789', new Date()),
      );

      const recent = fallbackOutbox.getRecentEvents();
      expect(recent).toHaveLength(1);
      expect(recent[0].type).toBe('file.trashed');
      expect(recent[0].payload.fileId).toBe('file-004');
    });
  });

  describe('StorageBackupService - Automated Project & Metadata Backup', () => {
    let backupService: StorageBackupService;
    let mockDriver: any;
    let mockNodeRepo: any;
    let mockBlobRepo: any;

    beforeEach(() => {
      mockDriver = {
        getStream: jest.fn(),
        put: jest.fn().mockResolvedValue(undefined),
      };
      mockNodeRepo = {
        list: jest.fn(),
      };
      mockBlobRepo = {
        findById: jest.fn(),
      };

      backupService = new StorageBackupService(
        mockDriver,
        mockNodeRepo,
        mockBlobRepo,
      );
    });

    it('should export project files into a zipped archive and upload to S3 backup path', async () => {
      const rootFolder = new StorageNode({
        id: 'folder-1',
        name: 'Analysis',
        isFolder: true,
        size: 0n,
        authorId: 'user-001',
        projectId: 'proj-001',
      });

      const fileInFolder = new StorageNode({
        id: 'file-1',
        name: 'results.csv',
        isFolder: false,
        size: 25n,
        parentId: 'folder-1',
        blobId: 'blob-1',
        mimeType: 'text/csv',
        authorId: 'user-001',
        projectId: 'proj-001',
      });

      const rootFile = new StorageNode({
        id: 'file-2',
        name: 'notes.txt',
        isFolder: false,
        size: 10n,
        blobId: 'blob-2',
        mimeType: 'text/plain',
        authorId: 'user-001',
        projectId: 'proj-001',
      });

      const blob1 = new StorageBlob({
        id: 'blob-1',
        contentHash: ContentHash.fromHex('1'.repeat(64)),
        sizeBytes: 25n,
        s3Key: StorageKey.fromString('blobs/11/results.csv'),
        s3Bucket: 'flux',
      });

      const blob2 = new StorageBlob({
        id: 'blob-2',
        contentHash: ContentHash.fromHex('2'.repeat(64)),
        sizeBytes: 10n,
        s3Key: StorageKey.fromString('blobs/22/notes.txt'),
        s3Bucket: 'flux',
      });

      mockNodeRepo.list
        .mockResolvedValueOnce({
          nodes: [rootFolder, rootFile],
          total: 2,
        })
        .mockResolvedValueOnce({
          nodes: [fileInFolder],
          total: 1,
        });

      mockBlobRepo.findById
        .mockResolvedValueOnce(blob1)
        .mockResolvedValueOnce(blob2);

      mockDriver.getStream
        .mockResolvedValueOnce({
          stream: Readable.from([Buffer.from('experiment_1,10.5,pass\n')]),
        })
        .mockResolvedValueOnce({
          stream: Readable.from([Buffer.from('hello world')]),
        });

      const result = await backupService.exportProjectArchive('proj-001');

      expect(result.backupKey).toContain('backups/projects/proj-001/backup-');
      expect(result.fileCount).toBe(2);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

      expect(mockDriver.put).toHaveBeenCalledWith(
        expect.stringContaining('backups/projects/proj-001/'),
        expect.any(Buffer),
        expect.objectContaining({ mimeType: 'application/zip' }),
      );
    });

    it('should export storage metadata catalog snapshot as gzipped JSON', async () => {
      const result = await backupService.exportMetadataSnapshot();

      expect(result.backupKey).toContain('backups/metadata/snapshot-');
      expect(result.backupKey).toContain('.json.gz');
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

      expect(mockDriver.put).toHaveBeenCalledWith(
        expect.stringContaining('backups/metadata/snapshot-'),
        expect.any(Buffer),
        expect.objectContaining({ mimeType: 'application/gzip' }),
      );
    });
  });
});
