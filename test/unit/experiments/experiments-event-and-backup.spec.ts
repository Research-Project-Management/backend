import { Readable } from 'node:stream';
import { fromPartial } from '@total-typescript/shoehorn';
import type { RedisCommandService } from '@/core';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
import {
  BlobStatus,
  type IFilesPort,
  type StorageBlobRecord,
} from '@/modules/files/types/files.type';
import {
  FileDownloadedEvent,
  FileTrashedEvent,
  FileUploadedEvent,
} from '@/modules/experiments';
import { ExperimentNode } from '@/modules/experiments/domain/node.domain';
import { ExperimentsEventListener } from '@/modules/experiments/processors/experiments.listener';
import { NodeRepository } from '@/modules/experiments/repositories/node.repository';
import { ExperimentsBackupService } from '@/modules/experiments/services/backup.service';

describe('Experiments Event Outbox & Backup Pipeline Suite', () => {
  describe('ExperimentsEventListener - Durable Streams, PubSub & Fallback', () => {
    it('dispatches file.uploaded and file.downloaded events to Redis Stream/PubSub and falls back to memory when Redis is absent', async () => {
      const publish = jest.fn().mockResolvedValue(1);
      const xadd = jest.fn().mockResolvedValue('1700000000000-0');
      const mockRedis = fromPartial({
        getClient: jest.fn(() => fromPartial({ publish, xadd })),
        isReady: jest.fn().mockReturnValue(true),
      });

      const listener = new ExperimentsEventListener(mockRedis as never);

      await listener.handleFileUploaded(
        new FileUploadedEvent(
          'file-001',
          'blob-001',
          'user-123',
          'dataset.csv',
          'text/csv',
          1024n,
          'blobs/aa/test.csv',
          'project-abc',
        ),
      );

      expect(publish).toHaveBeenCalledWith(
        'flux:experiments:events',
        expect.stringContaining('file.uploaded'),
      );
      expect(xadd).toHaveBeenCalledWith(
        'flux:experiments:stream',
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

      await listener.handleFileDownloaded(
        new FileDownloadedEvent(
          'file-002',
          'paper.pdf',
          'application/pdf',
          2048,
          'user-456',
          '192.168.1.1',
        ),
      );

      const recent = listener.getRecentEvents();
      expect(recent).toHaveLength(2);
      expect(recent.map((e) => e.type)).toEqual(
        expect.arrayContaining(['file.uploaded', 'file.downloaded']),
      );

      const fallback = new ExperimentsEventListener(undefined);
      await fallback.handleFileTrashed(
        new FileTrashedEvent('file-004', 'user-789', new Date()),
      );
      expect(fallback.getRecentEvents()).toEqual([
        expect.objectContaining({
          type: 'file.trashed',
          payload: expect.objectContaining({ fileId: 'file-004' }),
        }),
      ]);
    });
  });

  describe('ExperimentsBackupService - Project ZIP & Metadata Snapshot', () => {
    it('exports project files into a zipped archive and metadata catalog snapshot as gzipped JSON', async () => {
      const rootFolder = new ExperimentNode({
        id: 'folder-1',
        name: 'Analysis',
        isFolder: true,
        size: 0n,
        authorId: 'user-001',
        projectId: 'proj-001',
      });
      const fileInFolder = new ExperimentNode({
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
      const rootFile = new ExperimentNode({
        id: 'file-2',
        name: 'notes.txt',
        isFolder: false,
        size: 10n,
        blobId: 'blob-2',
        mimeType: 'text/plain',
        authorId: 'user-001',
        projectId: 'proj-001',
      });

      const makeBlob = (id: string, hexChar: string, key: string): StorageBlobRecord => ({
        id,
        contentHashHex: ContentHash.fromHex(hexChar.repeat(64)).toHex(),
        hashAlgorithm: 'SHA256',
        sizeBytes: 25n,
        mimeType: 'text/plain',
        checksumVerified: true,
        s3Key: StorageKey.fromString(key).value(),
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        refCount: 1,
        status: BlobStatus.READY,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      });

      const putObject = jest.fn().mockResolvedValue(undefined);
      const filesPort = fromPartial<IFilesPort>({
        findBlobById: jest
          .fn()
          .mockResolvedValueOnce(makeBlob('blob-1', '1', 'blobs/11/results.csv'))
          .mockResolvedValueOnce(makeBlob('blob-2', '2', 'blobs/22/notes.txt')),
        getObjectStream: jest
          .fn()
          .mockResolvedValueOnce({
            stream: Readable.from([Buffer.from('experiment_1,10.5,pass\n')]),
            contentLength: 23,
          })
          .mockResolvedValueOnce({
            stream: Readable.from([Buffer.from('hello world')]),
            contentLength: 11,
          }),
        putObject,
      });

      const nodeRepo = fromPartial<NodeRepository>({
        list: jest
          .fn()
          .mockResolvedValueOnce({ nodes: [rootFolder, rootFile], total: 2 })
          .mockResolvedValueOnce({ nodes: [fileInFolder], total: 1 }),
      });

      const backupService = new ExperimentsBackupService(filesPort, nodeRepo);

      const archive = await backupService.exportProjectArchive('proj-001');
      expect(archive.backupKey).toContain('backups/projects/proj-001/backup-');
      expect(archive.fileCount).toBe(2);
      expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(putObject).toHaveBeenCalledWith(
        expect.stringContaining('backups/projects/proj-001/'),
        expect.any(Buffer),
        expect.objectContaining({ mimeType: 'application/zip' }),
      );

      const snapshot = await backupService.exportMetadataSnapshot();
      expect(snapshot.backupKey).toMatch(/^backups\/metadata\/snapshot-.*\.json\.gz$/);
      expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(putObject).toHaveBeenCalledWith(
        expect.stringContaining('backups/metadata/snapshot-'),
        expect.any(Buffer),
        expect.objectContaining({ mimeType: 'application/gzip' }),
      );
    });
  });
});
