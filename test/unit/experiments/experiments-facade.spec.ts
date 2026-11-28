import { Readable } from 'node:stream';
import { BadRequestException, HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { fromPartial } from '@total-typescript/shoehorn';
import type { FastifyReply } from 'fastify';
import { DEFAULT_STORAGE_QUOTA_BYTES } from '@/modules/files/files.constant';
import {
  ByteRange,
  ContentHash,
  StorageKey,
} from '@/modules/files/domain/storage.vo';
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
} from '@/modules/files/types/files.type';
import { ExperimentsFacade } from '@/modules/experiments';
import { ExperimentsController } from '@/modules/experiments/controllers/experiments.controller';
import { StreamController } from '@/modules/experiments/controllers/stream.controller';
import { ExperimentsAccessPolicy } from '@/modules/experiments/domain/access.policy';
import { crc32, ZipPackager } from '@/modules/experiments/domain/archive.domain';
import { ExperimentNode, FileScope } from '@/modules/experiments/domain/node.domain';
import { NodeRepository } from '@/modules/experiments/repositories/node.repository';
import { VersionRepository } from '@/modules/experiments/repositories/version.repository';
import { ExperimentsCacheService } from '@/modules/experiments/services/cache.service';
import { ExperimentsService } from '@/modules/experiments/services/experiments.service';
import { StreamService } from '@/modules/experiments/services/stream.service';
import { TrashService } from '@/modules/experiments/services/trash.service';
import { UploadService } from '@/modules/experiments/services/upload.service';

describe('Experiments Domain, Facade, Batch ZIP & Trash Purge Suite', () => {
  describe('Domain Value Objects & ExperimentNode Invariants', () => {
    it('computes SHA-256 ContentHash, parses RFC 7233 ByteRange, and shards/sanitizes StorageKey', () => {
      const payload = Buffer.from('Quantum Machine Learning Research Paper 2026');
      const h1 = ContentHash.fromBuffer(payload);
      const h2 = ContentHash.fromBuffer(payload);
      expect(h1.toHex()).toHaveLength(64);
      expect(h1.equals(h2)).toBe(true);
      expect(() => ContentHash.fromHex('invalid-hex')).toThrow();
      expect(() => ContentHash.fromHex('1234')).toThrow();

      const standard = ByteRange.parse('bytes=0-499', 1000);
      expect(standard?.start).toBe(0);
      expect(standard?.end).toBe(499);
      expect(standard?.length).toBe(500);
      expect(standard?.getContentRangeHeader()).toBe('bytes 0-499/1000');

      const prefix = ByteRange.parse('bytes=500-', 1000);
      expect([prefix?.start, prefix?.end]).toEqual([500, 999]);

      const suffix = ByteRange.parse('bytes=-200', 1000);
      expect([suffix?.start, suffix?.end]).toEqual([800, 999]);

      expect(ByteRange.parse('bytes=1000-2000', 500)).toBeNull();
      expect(ByteRange.parse('bytes=500-200', 1000)).toBeNull();
      expect(ByteRange.parse('invalid-range', 1000)).toBeNull();

      const sha256 =
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      expect(StorageKey.forBlob(sha256).value()).toBe(`blobs/e3/b0/${sha256}`);
      expect(StorageKey.fromString('../../etc/passwd/key').value()).not.toContain(
        '..',
      );
    });

    it('prevents circular folder self-moves and evaluates soft-delete state on ExperimentNode', () => {
      const folder = new ExperimentNode({
        id: 'folder-1',
        name: 'Research Papers',
        isFolder: true,
        size: 0n,
        authorId: 'user-1',
      });
      expect(() => folder.moveTo('folder-1')).toThrow(
        'A folder cannot be moved into itself',
      );

      const active = new ExperimentNode({
        id: 'file-1',
        name: 'results.csv',
        isFolder: false,
        size: 2048n,
        authorId: 'user-1',
        scope: FileScope.Project,
      });
      const trashed = new ExperimentNode({
        id: 'file-2',
        name: 'trashed.csv',
        isFolder: false,
        size: 2048n,
        authorId: 'user-1',
        scope: FileScope.Project,
        trashedAt: new Date(),
      });
      expect(active.isTrashed()).toBe(false);
      expect(trashed.isTrashed()).toBe(true);
    });
  });

  describe('ExperimentsFacade, Batch Move, Bulk ZIP & Cascading Trash Purge', () => {
    let facade: ExperimentsFacade;
    let streamService: StreamService;
    let trashService: TrashService;
    let mockDriver: jest.Mocked<IStorageAdapter>;
    let mockNodeRepo: jest.Mocked<NodeRepository>;
    let mockBlobRepo: jest.Mocked<BlobRepository>;
    let mockQuotaRepo: jest.Mocked<QuotaRepository>;
    let mockCache: jest.Mocked<ExperimentsCacheService>;

    const nodesInDb = new Map<string, ExperimentNode>();
    const blobsInDb = new Map<string, StorageBlobRecord>();
    const driverStorage = new Map<string, Buffer>();

    beforeEach(() => {
      nodesInDb.clear();
      blobsInDb.clear();
      driverStorage.clear();

      mockDriver = fromPartial<jest.Mocked<IStorageAdapter>>({
        put: jest.fn(async (key: string, data: Buffer | Readable) => {
          if (Buffer.isBuffer(data)) driverStorage.set(key, data);
        }),
        getStream: jest.fn(async (key: string) => {
          const buf = driverStorage.get(key) || Buffer.from('mock-content');
          return { stream: Readable.from(buf), contentLength: buf.length };
        }),
        getPresignedUploadUrl: jest
          .fn()
          .mockResolvedValue('https://storage.flux.ai/upload/signed-url'),
        getPresignedDownloadUrl: jest
          .fn()
          .mockResolvedValue('https://storage.flux.ai/download/signed-url'),
      });

      mockNodeRepo = fromPartial<jest.Mocked<NodeRepository>>({
        findById: jest.fn(async (id: string) => nodesInDb.get(id) ?? null),
        create: jest.fn(async (node: ExperimentNode) => {
          nodesInDb.set(node.id, node);
          return node;
        }),
        update: jest.fn(async (node: ExperimentNode) => {
          nodesInDb.set(node.id, node);
          return node;
        }),
        delete: jest.fn(async (id: string) => {
          nodesInDb.delete(id);
        }),
        findExpiredTrash: jest.fn().mockResolvedValue([]),
        findSubtreeNodes: jest.fn().mockResolvedValue([]),
      });

      mockBlobRepo = fromPartial<jest.Mocked<BlobRepository>>({
        findById: jest.fn(async (id: string) => blobsInDb.get(id) ?? null),
        findByHash: jest.fn(async (hashHex: string) => {
          for (const blob of blobsInDb.values()) {
            if (blob.contentHashHex === hashHex) return blob;
          }
          return null;
        }),
        create: jest.fn(async (input) => {
          const blob: StorageBlobRecord = {
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
          };
          blobsInDb.set(blob.id, blob);
          return blob;
        }),
        incrementRefCount: jest.fn(async (id: string) => {
          const blob = blobsInDb.get(id)!;
          const updated: StorageBlobRecord = {
            ...blob,
            status: BlobStatus.READY,
            refCount: blob.refCount + 1,
          };
          blobsInDb.set(id, updated);
          return updated;
        }),
        decrementRefCount: jest.fn(async (id: string) => {
          const blob = blobsInDb.get(id);
          if (!blob) return null;
          const newCount = Math.max(0, blob.refCount - 1);
          const updated: StorageBlobRecord = {
            ...blob,
            status: newCount === 0 ? BlobStatus.DELETED : BlobStatus.READY,
            refCount: newCount,
          };
          blobsInDb.set(id, updated);
          return updated;
        }),
        hasSpaceAccessToBlob: jest.fn().mockResolvedValue(true),
      });

      mockQuotaRepo = fromPartial<jest.Mocked<QuotaRepository>>({
        findBySpaceId: jest.fn().mockResolvedValue(null),
        assertAvailable: jest.fn(async (_spaceId, requiredBytes: bigint) => {
          if (requiredBytes > DEFAULT_STORAGE_QUOTA_BYTES) {
            throw new BadRequestException('Storage quota exceeded');
          }
        }),
        incrementUsage: jest.fn().mockResolvedValue(1000n),
        decrementUsage: jest.fn().mockResolvedValue(0n),
      });

      mockCache = fromPartial<jest.Mocked<ExperimentsCacheService>>({
        getFolderListing: jest.fn().mockResolvedValue(null),
        setFolderListing: jest.fn(),
        invalidateFolder: jest.fn(),
        invalidateScopeTree: jest.fn(),
        getPresignedUrl: jest.fn().mockResolvedValue(null),
        setPresignedUrl: jest.fn().mockResolvedValue(undefined),
      });

      const mockEvents = fromPartial<EventEmitter2>({ emit: jest.fn() });
      const blobService = new BlobService(mockDriver, mockBlobRepo);
      const filesFacade = new FilesFacade(
        mockDriver,
        blobService,
        mockBlobRepo,
        mockQuotaRepo,
        new FilesUploadService(
          mockDriver,
          blobService,
          mockBlobRepo,
          mockQuotaRepo,
          fromPartial<SessionRepository>({}),
        ),
      );

      const uploadService = new UploadService(
        filesFacade,
        mockNodeRepo,
        mockCache,
        mockEvents,
      );
      const mockAccessPolicy = fromPartial<ExperimentsAccessPolicy>({
        assertCanAccess: jest.fn().mockResolvedValue(undefined),
      });

      streamService = new StreamService(
        filesFacade,
        mockNodeRepo,
        mockCache,
        mockAccessPolicy,
      );
      trashService = new TrashService(
        mockNodeRepo,
        filesFacade,
        mockCache,
        mockEvents,
        fromPartial<VersionRepository>({
          findByFileId: jest.fn().mockResolvedValue([]),
          deleteByFileId: jest.fn(),
        }),
      );

      facade = new ExperimentsFacade(
        filesFacade,
        mockNodeRepo,
        uploadService,
        trashService,
        streamService,
        fromPartial<ExperimentsService>({}),
        mockAccessPolicy,
      );
    });

    it('uploads files with CAS deduplication, reads/streams owned files, generates presigned URLs, and blocks executables', async () => {
      const pdfContent = Buffer.from(
        '%PDF-1.7 Identical Content Across Two Different Authors',
      );
      const res1 = await facade.uploadFile({
        userId: 'tenant-team-1',
        filename: 'researcher1_copy.pdf',
        buffer: pdfContent,
        mimeType: 'application/pdf',
      });
      const res2 = await facade.uploadFile({
        userId: 'tenant-team-1',
        filename: 'researcher2_copy.pdf',
        buffer: pdfContent,
        mimeType: 'application/pdf',
      });

      expect(mockDriver.put).toHaveBeenCalledTimes(1);
      expect(blobsInDb.size).toBe(1);
      expect(Array.from(blobsInDb.values())[0].refCount).toBe(2);
      expect(nodesInDb.size).toBe(2);
      expect(res1.fileId).not.toBe(res2.fileId);
      expect(res1.url).toBe(
        `/api/v1/experiments/files/${encodeURIComponent(res1.fileId)}/content`,
      );

      const readRes = await facade.readOwnedFile({
        fileId: res1.fileId,
        userId: 'tenant-team-1',
      });
      expect(readRes.buffer.toString()).toBe(pdfContent.toString());

      const streamRes = await facade.getOwnedFileStream({
        fileId: res1.fileId,
        userId: 'tenant-team-1',
      });
      expect(streamRes.mimeType).toBe('application/pdf');
      expect(streamRes.filename).toBe('researcher1_copy.pdf');

      await expect(
        facade.getPresignedDownloadUrl(res1.fileId),
      ).resolves.toBe('https://storage.flux.ai/download/signed-url');
      const uploadRes = await facade.getPresignedUploadUrl({
        userId: 'tenant-team-1',
        filename: 'large-dataset.csv',
        mimeType: 'text/csv',
        sizeBytes: 50 * 1024 * 1024,
      });
      expect(uploadRes.uploadUrl).toBe(
        'https://storage.flux.ai/upload/signed-url',
      );
      expect(uploadRes.storageKey).toContain('uploads/staging/tenant-team-1/');

      await expect(
        facade.uploadFile({
          userId: 'user-attacker',
          filename: 'malware.exe',
          buffer: Buffer.from('MZ... executable payload'),
          mimeType: 'application/x-msdownload',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('packages PKZIP archives with valid CRC-32, executes batchMove, and streams bulk ZIP downloads', async () => {
      expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);

      const zip = new ZipPackager();
      zip.addFile('experiments/results.csv', Buffer.from('id,val\n1,100\n'));
      zip.addFile('scripts/train.py', Buffer.from('print(42)\n'));
      const zipBuffer = zip.build();

      expect([zipBuffer[0], zipBuffer[1], zipBuffer[2], zipBuffer[3]]).toEqual([
        0x50, 0x4b, 0x03, 0x04,
      ]);
      const eocdIndex = zipBuffer.lastIndexOf(
        Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      );
      expect(eocdIndex).toBeGreaterThan(-1);
      expect(zipBuffer.readUInt16LE(eocdIndex + 8)).toBe(2);

      // Batch move controller seam
      const moveFn = jest.fn().mockResolvedValue(undefined);
      const expController = new ExperimentsController(
        fromPartial<ExperimentsService>({
          batchMove: jest.fn(async (ids: string[], targetFolderId: string | null) => {
            for (const id of ids) await moveFn(id, targetFolderId);
            return ids.length;
          }),
        }),
        trashService,
        fromPartial<ExperimentsAccessPolicy>({
          assertCanAccess: jest.fn().mockResolvedValue(undefined),
        }),
      );
      const moveRes = await expController.batchMove({
        ids: ['file-1', 'file-2', 'file-3'],
        targetFolderId: 'folder-dest-99',
      });
      expect(moveRes).toEqual({ success: true, count: 3 });
      expect(moveFn).toHaveBeenCalledTimes(3);

      // Bulk ZIP download controller seam
      const uploadedCsv = await facade.uploadFile({
        userId: 'user-1',
        filename: 'dataset.csv',
        buffer: Buffer.from('col1,col2\nval1,val2\n'),
        mimeType: 'text/csv',
      });

      let sentBuffer: unknown;
      let status = 0;
      const headers = new Map<string, string>();
      const reply: FastifyReply = fromPartial<FastifyReply>({
        status: jest.fn((c: number) => {
          status = c;
          return reply;
        }),
        header: jest.fn((k: string, v: unknown) => {
          headers.set(k, String(v));
          return reply;
        }),
        send: jest.fn((b: unknown) => {
          sentBuffer = b;
          return reply;
        }),
      });

      const streamController = new StreamController(
        streamService,
        fromPartial<EventEmitter2>({ emit: jest.fn() }),
      );
      await streamController.bulkDownloadGet(
        uploadedCsv.fileId,
        reply,
        'user-1',
      );

      expect(status).toBe(HttpStatus.OK);
      expect(headers.get('Content-Type')).toBe('application/zip');
      expect(Buffer.isBuffer(sentBuffer)).toBe(true);
      expect((sentBuffer as Buffer).toString('utf8')).toContain('dataset.csv');
    });

    it('purges expired trash files and cascading folder subtrees while reclaiming quota and decrementing CAS refCount', async () => {
      const blob1Id = 'blob-001';
      blobsInDb.set(blob1Id, {
        id: blob1Id,
        contentHashHex: 'a'.repeat(64),
        hashAlgorithm: 'SHA256',
        sizeBytes: 1048576n,
        mimeType: 'application/pdf',
        checksumVerified: true,
        s3Key: 'blobs/aa/test.pdf',
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        status: BlobStatus.READY,
        refCount: 2,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      });

      const expiredFile = new ExperimentNode({
        id: 'file-001',
        name: 'old-paper.pdf',
        isFolder: false,
        size: 1048576n,
        blobId: blob1Id,
        authorId: 'user-001',
        projectId: 'project-001',
      });
      nodesInDb.set(expiredFile.id, expiredFile);
      mockNodeRepo.findExpiredTrash.mockResolvedValueOnce([expiredFile]);

      const singlePurge = await trashService.processExpiredTrash(30);
      expect(singlePurge).toEqual({
        purgedCount: 1,
        reclaimedBytes: 1048576n,
        errors: 0,
      });
      expect(blobsInDb.get(blob1Id)?.refCount).toBe(1);
      expect(mockQuotaRepo.decrementUsage).toHaveBeenCalledWith(
        'project-001',
        1048576n,
      );

      // Cascading folder subtree purge
      const childBlobId = 'blob-child-01';
      blobsInDb.set(childBlobId, {
        id: childBlobId,
        contentHashHex: 'b'.repeat(64),
        hashAlgorithm: 'SHA256',
        sizeBytes: 2048n,
        mimeType: 'text/csv',
        checksumVerified: true,
        s3Key: 'blobs/bb/dataset.csv',
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        status: BlobStatus.READY,
        refCount: 1,
        createdAt: new Date(),
        tombstoneAt: null,
        claimedAt: null,
      });

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
        blobId: childBlobId,
        authorId: 'user-001',
      });

      mockNodeRepo.findExpiredTrash.mockResolvedValueOnce([expiredFolder]);
      mockNodeRepo.findSubtreeNodes.mockResolvedValueOnce([
        expiredFolder,
        childFile,
      ]);

      const folderPurge = await trashService.processExpiredTrash(30);
      expect(folderPurge.purgedCount).toBe(2);
      expect(folderPurge.reclaimedBytes).toBe(2048n);
      expect(blobsInDb.get(childBlobId)?.status).toBe(BlobStatus.DELETED);
      expect(mockQuotaRepo.decrementUsage).toHaveBeenCalledWith(
        'user-001',
        2048n,
      );
    });
  });
});
