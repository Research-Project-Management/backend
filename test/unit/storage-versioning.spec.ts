import { UploadNewVersionUseCase } from '@/modules/storage/application/use-cases/version/upload-new-version.use-case';
import { GetFileVersionsUseCase } from '@/modules/storage/application/use-cases/version/get-file-versions.use-case';
import { DownloadFileVersionUseCase } from '@/modules/storage/application/use-cases/version/download-file-version.use-case';
import { RevertFileVersionUseCase } from '@/modules/storage/application/use-cases/version/revert-file-version.use-case';
import { StorageVersion } from '@/modules/storage/domain/entities/storage-version.entity';
import { StorageNode } from '@/modules/storage/domain/entities/storage-node.entity';
import { StorageBlob, BlobStatus } from '@/modules/storage/domain/entities/storage-blob.entity';
import { ContentHash } from '@/modules/storage/domain/value-objects/content-hash.vo';
import { StorageKey } from '@/modules/storage/domain/value-objects/storage-key.vo';
import { FileScope } from '@/modules/storage/domain/value-objects/file-scope.vo';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';

describe('Storage File & Dataset Versioning Suite', () => {
  let uploadNewVersionUseCase: UploadNewVersionUseCase;
  let getFileVersionsUseCase: GetFileVersionsUseCase;
  let downloadFileVersionUseCase: DownloadFileVersionUseCase;
  let revertFileVersionUseCase: RevertFileVersionUseCase;

  let mockDriver: any;
  let mockNodeRepo: any;
  let mockBlobRepo: any;
  let mockQuotaRepo: any;
  let mockVersionRepo: any;
  let mockAccessPolicy: any;
  let mockCache: any;
  let mockEventEmitter: any;

  let nodesInDb: Map<string, StorageNode>;
  let blobsInDb: Map<string, StorageBlob>;
  let versionsInDb: Map<string, StorageVersion[]>;

  beforeEach(() => {
    nodesInDb = new Map();
    blobsInDb = new Map();
    versionsInDb = new Map();

    mockDriver = {
      put: jest.fn().mockResolvedValue(undefined),
      getStream: jest.fn().mockImplementation(async () => ({
        stream: Readable.from(['mock-binary-data']),
        contentLength: 80,
      })),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    mockNodeRepo = {
      findById: jest.fn().mockImplementation(async (id: string) => nodesInDb.get(id) || null),
      create: jest.fn().mockImplementation(async (n: StorageNode) => {
        nodesInDb.set(n.id, n);
        return n;
      }),
      update: jest.fn().mockImplementation(async (n: StorageNode) => {
        nodesInDb.set(n.id, n);
        return n;
      }),
    };

    mockBlobRepo = {
      findById: jest.fn().mockImplementation(async (id: string) => blobsInDb.get(id) || null),
      findByHash: jest.fn().mockImplementation(async (hash: ContentHash) => {
        for (const blob of blobsInDb.values()) {
          if (blob.contentHash.equals(hash)) return blob;
        }
        return null;
      }),
      create: jest.fn().mockImplementation(async (b: StorageBlob) => {
        blobsInDb.set(b.id, b);
        return b;
      }),
      update: jest.fn().mockImplementation(async (b: StorageBlob) => {
        blobsInDb.set(b.id, b);
        return b;
      }),
    };

    mockQuotaRepo = {
      incrementUsage: jest.fn().mockResolvedValue(1000n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
    };

    mockVersionRepo = {
      create: jest.fn().mockImplementation(async (v: StorageVersion) => {
        const list = versionsInDb.get(v.fileId) || [];
        list.push(v);
        versionsInDb.set(v.fileId, list);
        return v;
      }),
      findByFileId: jest.fn().mockImplementation(async (fileId: string) => {
        const list = versionsInDb.get(fileId) || [];
        return [...list].sort((a, b) => b.versionNumber - a.versionNumber);
      }),
      findByFileAndVersion: jest.fn().mockImplementation(async (fileId: string, vNum: number) => {
        const list = versionsInDb.get(fileId) || [];
        return list.find((v) => v.versionNumber === vNum) || null;
      }),
      getLatestVersionNumber: jest.fn().mockImplementation(async (fileId: string) => {
        const list = versionsInDb.get(fileId) || [];
        if (list.length === 0) return 0;
        return Math.max(...list.map((v) => v.versionNumber));
      }),
      deleteByFileId: jest.fn().mockImplementation(async (fileId: string) => {
        versionsInDb.delete(fileId);
      }),
    };

    mockAccessPolicy = {
      assertCanAccess: jest.fn().mockImplementation(async (userId: string, fileId: string) => {
        const node = nodesInDb.get(fileId);
        if (!node) throw new NotFoundException('File not found');
        return node;
      }),
    };

    mockCache = {
      invalidateFolder: jest.fn().mockResolvedValue(undefined),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    uploadNewVersionUseCase = new UploadNewVersionUseCase(
      mockDriver,
      mockNodeRepo,
      mockBlobRepo,
      mockQuotaRepo,
      mockVersionRepo,
      mockAccessPolicy,
      mockCache,
      mockEventEmitter,
    );

    getFileVersionsUseCase = new GetFileVersionsUseCase(
      mockVersionRepo,
      mockAccessPolicy,
    );

    downloadFileVersionUseCase = new DownloadFileVersionUseCase(
      mockDriver,
      mockBlobRepo,
      mockVersionRepo,
      mockAccessPolicy,
    );

    revertFileVersionUseCase = new RevertFileVersionUseCase(
      mockNodeRepo,
      mockBlobRepo,
      mockVersionRepo,
      mockAccessPolicy,
      mockCache,
      mockEventEmitter,
    );
  });

  describe('UploadNewVersionUseCase', () => {
    it('should upload version 2 for an existing file and backfill version 1', async () => {
      // Setup initial file
      const initialHash = ContentHash.fromBuffer(Buffer.from('version-1-content'));
      const initialBlob = new StorageBlob({
        id: 'blob-initial-1',
        contentHash: initialHash,
        sizeBytes: 100n,
        s3Key: StorageKey.forBlob(initialHash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
        refCount: 1,
      });
      blobsInDb.set(initialBlob.id, initialBlob);

      const fileNode = new StorageNode({
        id: 'file-paper-100',
        name: 'neural_networks.pdf',
        isFolder: false,
        size: 100n,
        mimeType: 'application/pdf',
        blobId: initialBlob.id,
        authorId: 'author-user-1',
        scope: FileScope.Project,
        projectId: 'project-ai',
      });
      nodesInDb.set(fileNode.id, fileNode);

      // Upload version 2 (with PDF magic bytes %PDF-1.5)
      const v2Buffer = Buffer.from('%PDF-1.5 Updated research paper content with new experiments');
      const result = await uploadNewVersionUseCase.execute({
        fileId: fileNode.id,
        userId: 'author-user-1',
        buffer: v2Buffer,
        filename: 'neural_networks.pdf',
        mimeType: 'application/pdf',
        changeComment: 'Bổ sung bảng so sánh thực nghiệm (Added experiment comparisons)',
      });

      expect(result.versionNumber).toBe(2);
      expect(result.fileId).toBe(fileNode.id);
      expect(result.changeComment).toBe('Bổ sung bảng so sánh thực nghiệm (Added experiment comparisons)');

      // StorageNode should now point to new blob
      const updatedNode = nodesInDb.get(fileNode.id)!;
      expect(updatedNode.blobId).not.toBe(initialBlob.id);
      expect(updatedNode.size).toBe(BigInt(v2Buffer.length));

      // Versions in DB should have both v1 and v2
      const versions = versionsInDb.get(fileNode.id)!;
      expect(versions.length).toBe(2);
      expect(versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);

      // Verify domain event emitted for AI indexing
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('file.uploaded', expect.anything());
    });

    it('should leverage CAS deduplication when uploading identical revision content', async () => {
      const fileNode = new StorageNode({
        id: 'file-dataset-100',
        name: 'experiment_results.csv',
        isFolder: false,
        size: 50n,
        mimeType: 'text/csv',
        blobId: 'blob-existing-csv',
        authorId: 'user-1',
      });
      nodesInDb.set(fileNode.id, fileNode);

      const identicalBuffer = Buffer.from('id,feature_a,feature_b\n1,0.95,0.88\n');
      const identicalHash = ContentHash.fromBuffer(identicalBuffer);
      const existingBlob = new StorageBlob({
        id: 'blob-existing-csv',
        contentHash: identicalHash,
        sizeBytes: BigInt(identicalBuffer.length),
        s3Key: StorageKey.forBlob(identicalHash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
        refCount: 1,
      });
      blobsInDb.set(existingBlob.id, existingBlob);

      const result = await uploadNewVersionUseCase.execute({
        fileId: fileNode.id,
        userId: 'user-1',
        buffer: identicalBuffer,
        filename: 'experiment_results.csv',
        mimeType: 'text/csv',
        changeComment: 'Re-uploaded identical dataset',
      });

      expect(result.isDeduplicated).toBe(true);
      expect(existingBlob.refCount).toBe(2);
      // No S3 put call needed for duplicate content
      expect(mockDriver.put).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when trying to version a folder', async () => {
      const folderNode = new StorageNode({
        id: 'folder-1',
        name: 'Datasets',
        isFolder: true,
        size: 0n,
        authorId: 'user-1',
      });
      nodesInDb.set(folderNode.id, folderNode);

      await expect(
        uploadNewVersionUseCase.execute({
          fileId: folderNode.id,
          userId: 'user-1',
          buffer: Buffer.from('data'),
          filename: 'Datasets',
          mimeType: 'text/plain',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('GetFileVersionsUseCase', () => {
    it('should return all versions with isCurrent flag and author info', async () => {
      const fileId = 'file-doc-1';
      const fileNode = new StorageNode({
        id: fileId,
        name: 'thesis_draft.docx',
        isFolder: false,
        size: 200n,
        blobId: 'blob-v2',
        authorId: 'student-1',
      });
      nodesInDb.set(fileId, fileNode);

      versionsInDb.set(fileId, [
        new StorageVersion({
          id: 'ver-1',
          fileId,
          blobId: 'blob-v1',
          versionNumber: 1,
          changeComment: 'Initial submission',
          createdById: 'student-1',
          sizeBytes: 150n,
        }),
        new StorageVersion({
          id: 'ver-2',
          fileId,
          blobId: 'blob-v2',
          versionNumber: 2,
          changeComment: 'Prof comments addressed',
          createdById: 'student-1',
          sizeBytes: 200n,
        }),
      ]);

      const result = await getFileVersionsUseCase.execute(fileId, 'student-1');

      expect(result.totalVersions).toBe(2);
      expect(result.currentVersionNumber).toBe(2);
      expect(result.versions[0].versionNumber).toBe(2);
      expect(result.versions[0].isCurrent).toBe(true);
      expect(result.versions[1].versionNumber).toBe(1);
      expect(result.versions[1].isCurrent).toBe(false);
    });
  });

  describe('DownloadFileVersionUseCase', () => {
    it('should download the specific historical version binary with versioned name', async () => {
      const fileId = 'file-target-1';
      const v1Hash = ContentHash.fromBuffer(Buffer.from('v1-content'));
      const v1Blob = new StorageBlob({
        id: 'blob-v1',
        contentHash: v1Hash,
        sizeBytes: 80n,
        s3Key: StorageKey.forBlob(v1Hash.toHex()),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
      });
      blobsInDb.set(v1Blob.id, v1Blob);

      const fileNode = new StorageNode({
        id: fileId,
        name: 'quantum_sim.py',
        isFolder: false,
        size: 120n,
        blobId: 'blob-v2',
        authorId: 'user-1',
        mimeType: 'text/x-python',
      });
      nodesInDb.set(fileId, fileNode);

      versionsInDb.set(fileId, [
        new StorageVersion({
          id: 'ver-1',
          fileId,
          blobId: 'blob-v1',
          versionNumber: 1,
          createdById: 'user-1',
          sizeBytes: 80n,
        }),
      ]);

      const result = await downloadFileVersionUseCase.execute(fileId, 1, 'user-1');

      expect(result.filename).toBe('quantum_sim_v1.py');
      expect(result.versionNumber).toBe(1);
      expect(result.size).toBe(80);
      expect(mockDriver.getStream).toHaveBeenCalledWith(v1Blob.s3Key.value());
    });
  });

  describe('RevertFileVersionUseCase', () => {
    it('should revert to an older version and create a new audit snapshot', async () => {
      const fileId = 'file-revert-1';
      const v1Blob = new StorageBlob({
        id: 'blob-v1',
        contentHash: ContentHash.fromBuffer(Buffer.from('v1')),
        sizeBytes: 50n,
        s3Key: StorageKey.forBlob('1111111111111111111111111111111111111111111111111111111111111111'),
        s3Bucket: 'flux',
        status: BlobStatus.READY,
        refCount: 1,
      });
      blobsInDb.set(v1Blob.id, v1Blob);

      const fileNode = new StorageNode({
        id: fileId,
        name: 'survey.csv',
        isFolder: false,
        size: 100n,
        blobId: 'blob-v2',
        authorId: 'user-1',
      });
      nodesInDb.set(fileId, fileNode);

      versionsInDb.set(fileId, [
        new StorageVersion({
          id: 'ver-1',
          fileId,
          blobId: 'blob-v1',
          versionNumber: 1,
          createdById: 'user-1',
          sizeBytes: 50n,
        }),
        new StorageVersion({
          id: 'ver-2',
          fileId,
          blobId: 'blob-v2',
          versionNumber: 2,
          createdById: 'user-1',
          sizeBytes: 100n,
        }),
      ]);

      const result = await revertFileVersionUseCase.execute(fileId, 1, 'user-1');

      expect(result.revertedToVersion).toBe(1);
      expect(result.newVersionNumber).toBe(3);
      expect(result.blobId).toBe('blob-v1');

      // Active node points to v1 blob
      const updatedNode = nodesInDb.get(fileId)!;
      expect(updatedNode.blobId).toBe('blob-v1');
      expect(updatedNode.size).toBe(50n);

      // Audit list has 3 versions now
      const versions = versionsInDb.get(fileId)!;
      expect(versions.length).toBe(3);
      expect(versions[2].versionNumber).toBe(3);
      expect(versions[2].changeComment).toContain('Khôi phục về Phiên bản 1');
    });
  });
});
