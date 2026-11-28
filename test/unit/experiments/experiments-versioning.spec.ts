import { Readable } from 'node:stream';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { fromPartial } from '@total-typescript/shoehorn';
import { ContentHash, StorageKey } from '@/modules/files/domain/storage.vo';
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
import { ExperimentsAccessPolicy } from '@/modules/experiments/domain/access.policy';
import { ExperimentNode, FileScope } from '@/modules/experiments/domain/node.domain';
import { ExperimentVersion } from '@/modules/experiments/domain/version.domain';
import { NodeRepository } from '@/modules/experiments/repositories/node.repository';
import { VersionRepository } from '@/modules/experiments/repositories/version.repository';
import { ExperimentsCacheService } from '@/modules/experiments/services/cache.service';
import { VersionService } from '@/modules/experiments/services/version.service';

describe('Experiments File & Dataset Versioning Suite', () => {
  let versionService: VersionService;
  let mockDriver: jest.Mocked<IStorageAdapter>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;

  let nodesInDb: Map<string, ExperimentNode>;
  let blobsInDb: Map<string, StorageBlobRecord>;
  let versionsInDb: Map<string, ExperimentVersion[]>;

  const makeBlob = (
    id: string,
    hashHex: string,
    sizeBytes: bigint,
    mimeType = 'application/pdf',
  ): StorageBlobRecord => ({
    id,
    contentHashHex: hashHex,
    hashAlgorithm: 'SHA256',
    sizeBytes,
    mimeType,
    checksumVerified: true,
    s3Key: StorageKey.forBlob(hashHex).value(),
    s3Bucket: 'flux',
    storageClass: 'STANDARD',
    status: BlobStatus.READY,
    refCount: 1,
    createdAt: new Date(),
    tombstoneAt: null,
    claimedAt: null,
  });

  beforeEach(() => {
    nodesInDb = new Map();
    blobsInDb = new Map();
    versionsInDb = new Map();

    mockDriver = fromPartial<jest.Mocked<IStorageAdapter>>({
      put: jest.fn().mockResolvedValue(undefined),
      getStream: jest.fn(async () => ({
        stream: Readable.from(['mock-binary-data']),
        contentLength: 80,
      })),
      delete: jest.fn().mockResolvedValue(undefined),
    });

    const mockNodeRepo = fromPartial<NodeRepository>({
      findById: jest.fn(async (id: string) => nodesInDb.get(id) ?? null),
      create: jest.fn(async (n: ExperimentNode) => {
        nodesInDb.set(n.id, n);
        return n;
      }),
      update: jest.fn(async (n: ExperimentNode) => {
        nodesInDb.set(n.id, n);
        return n;
      }),
    });

    const mockBlobRepo = fromPartial<BlobRepository>({
      findById: jest.fn(async (id: string) => blobsInDb.get(id) ?? null),
      findByHash: jest.fn(async (hashHex: string) => {
        for (const blob of blobsInDb.values()) {
          if (blob.contentHashHex === hashHex) return blob;
        }
        return null;
      }),
      create: jest.fn(async (input) => {
        const record: StorageBlobRecord = {
          id: input.id,
          contentHashHex: input.contentHashHex,
          hashAlgorithm: 'SHA256',
          sizeBytes: input.sizeBytes,
          mimeType: input.mimeType,
          checksumVerified: input.checksumVerified,
          s3Key: input.s3Key,
          s3Bucket: input.s3Bucket,
          storageClass: 'STANDARD',
          status: input.status ?? BlobStatus.READY,
          refCount: input.refCount ?? 1,
          createdAt: new Date(),
          tombstoneAt: null,
          claimedAt: null,
        };
        blobsInDb.set(record.id, record);
        return record;
      }),
      incrementRefCount: jest.fn(async (id: string) => {
        const b = blobsInDb.get(id);
        if (!b) throw new NotFoundException('Blob not found');
        const updated = { ...b, status: BlobStatus.READY, refCount: b.refCount + 1 };
        blobsInDb.set(id, updated);
        return updated;
      }),
      decrementRefCount: jest.fn(async (id: string) => {
        const b = blobsInDb.get(id);
        if (!b) return null;
        const newCount = Math.max(0, b.refCount - 1);
        const updated = {
          ...b,
          status: newCount === 0 ? BlobStatus.DELETED : BlobStatus.READY,
          refCount: newCount,
        };
        blobsInDb.set(id, updated);
        return updated;
      }),
      hasSpaceAccessToBlob: jest.fn().mockResolvedValue(true),
    });

    const mockQuotaRepo = fromPartial<QuotaRepository>({
      findBySpaceId: jest.fn().mockResolvedValue(null),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      incrementUsage: jest.fn().mockResolvedValue(1000n),
      decrementUsage: jest.fn().mockResolvedValue(0n),
    });

    const mockVersionRepo = fromPartial<VersionRepository>({
      create: jest.fn(async (v: ExperimentVersion) => {
        const list = versionsInDb.get(v.fileId) || [];
        list.push(v);
        versionsInDb.set(v.fileId, list);
        return v;
      }),
      findByFileId: jest.fn(async (fileId: string) =>
        [...(versionsInDb.get(fileId) || [])].sort(
          (a, b) => b.versionNumber - a.versionNumber,
        ),
      ),
      findByFileAndVersion: jest.fn(async (fileId: string, vNum: number) =>
        (versionsInDb.get(fileId) || []).find((v) => v.versionNumber === vNum) ??
        null,
      ),
      getLatestVersionNumber: jest.fn(async (fileId: string) => {
        const list = versionsInDb.get(fileId) || [];
        return list.length === 0
          ? 0
          : Math.max(...list.map((v) => v.versionNumber));
      }),
      deleteByFileId: jest.fn(async (fileId: string) => {
        versionsInDb.delete(fileId);
      }),
    });

    const mockAccessPolicy = fromPartial<ExperimentsAccessPolicy>({
      assertCanAccess: jest.fn(async (_userId: string, fileId: string) => {
        const node = nodesInDb.get(fileId);
        if (!node) throw new NotFoundException('File not found');
        return node;
      }),
    });

    mockEventEmitter = fromPartial<jest.Mocked<EventEmitter2>>({
      emit: jest.fn(),
    });

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
        fromPartial<SessionRepository>({}),
      ),
    );
    versionService = new VersionService(
      filesPort,
      mockNodeRepo,
      mockVersionRepo,
      mockAccessPolicy,
      fromPartial<ExperimentsCacheService>({
        invalidateFolder: jest.fn().mockResolvedValue(undefined),
      }),
      mockEventEmitter,
    );
  });

  it('uploads version 2 while backfilling version 1, deduplicates identical revisions via CAS, and rejects folder versioning', async () => {
    const initialHash = ContentHash.fromBuffer(
      Buffer.from('version-1-content'),
    ).toHex();
    blobsInDb.set('blob-initial-1', makeBlob('blob-initial-1', initialHash, 100n));

    const fileNode = new ExperimentNode({
      id: 'file-paper-100',
      name: 'neural_networks.pdf',
      isFolder: false,
      size: 100n,
      mimeType: 'application/pdf',
      blobId: 'blob-initial-1',
      authorId: 'author-user-1',
      scope: FileScope.Project,
      projectId: 'project-ai',
    });
    nodesInDb.set(fileNode.id, fileNode);

    const v2Buffer = Buffer.from(
      '%PDF-1.5 Updated research paper content with new experiments',
    );
    const v2Res = await versionService.uploadVersion({
      fileId: fileNode.id,
      userId: 'author-user-1',
      buffer: v2Buffer,
      filename: 'neural_networks.pdf',
      mimeType: 'application/pdf',
      changeComment: 'Added experiment comparisons',
    });

    expect(v2Res.versionNumber).toBe(2);
    expect(nodesInDb.get(fileNode.id)?.size).toBe(BigInt(v2Buffer.length));
    expect(
      versionsInDb
        .get(fileNode.id)
        ?.map((v) => v.versionNumber)
        .sort(),
    ).toEqual([1, 2]);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      'file.uploaded',
      expect.anything(),
    );

    // CAS dedup on identical revision
    const csvBuf = Buffer.from('id,feature_a\n1,0.95\n');
    const csvHash = ContentHash.fromBuffer(csvBuf).toHex();
    blobsInDb.set(
      'blob-existing-csv',
      makeBlob('blob-existing-csv', csvHash, BigInt(csvBuf.length), 'text/csv'),
    );
    nodesInDb.set(
      'file-dataset-100',
      new ExperimentNode({
        id: 'file-dataset-100',
        name: 'results.csv',
        isFolder: false,
        size: BigInt(csvBuf.length),
        mimeType: 'text/csv',
        blobId: 'blob-existing-csv',
        authorId: 'user-1',
      }),
    );

    mockDriver.put.mockClear();
    const dedupRes = await versionService.uploadVersion({
      fileId: 'file-dataset-100',
      userId: 'user-1',
      buffer: csvBuf,
      filename: 'results.csv',
      mimeType: 'text/csv',
    });
    expect(dedupRes.isDeduplicated).toBe(true);
    expect(blobsInDb.get('blob-existing-csv')?.refCount).toBe(2);
    expect(mockDriver.put).not.toHaveBeenCalled();

    // Folder versioning rejected
    nodesInDb.set(
      'folder-1',
      new ExperimentNode({
        id: 'folder-1',
        name: 'Datasets',
        isFolder: true,
        size: 0n,
        authorId: 'user-1',
      }),
    );
    await expect(
      versionService.uploadVersion({
        fileId: 'folder-1',
        userId: 'user-1',
        buffer: Buffer.from('data'),
        filename: 'Datasets',
        mimeType: 'text/plain',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lists versions with isCurrent flags, downloads historical versioned filenames, and reverts to create audit snapshots', async () => {
    const fileId = 'file-target-1';
    const v1Hash = ContentHash.fromBuffer(Buffer.from('v1-content')).toHex();
    const v1Blob = makeBlob('blob-v1', v1Hash, 80n, 'text/x-python');
    blobsInDb.set('blob-v1', v1Blob);

    nodesInDb.set(
      fileId,
      new ExperimentNode({
        id: fileId,
        name: 'quantum_sim.py',
        isFolder: false,
        size: 120n,
        blobId: 'blob-v2',
        authorId: 'user-1',
        mimeType: 'text/x-python',
      }),
    );
    versionsInDb.set(fileId, [
      new ExperimentVersion({
        id: 'ver-1',
        fileId,
        blobId: 'blob-v1',
        versionNumber: 1,
        createdById: 'user-1',
        sizeBytes: 80n,
      }),
      new ExperimentVersion({
        id: 'ver-2',
        fileId,
        blobId: 'blob-v2',
        versionNumber: 2,
        createdById: 'user-1',
        sizeBytes: 120n,
      }),
    ]);

    const listed = await versionService.listVersions(fileId, 'user-1');
    expect(listed.totalVersions).toBe(2);
    expect(listed.currentVersionNumber).toBe(2);
    expect(listed.versions[0]).toMatchObject({ versionNumber: 2, isCurrent: true });
    expect(listed.versions[1]).toMatchObject({ versionNumber: 1, isCurrent: false });

    const downloaded = await versionService.downloadVersion(fileId, 1, 'user-1');
    expect(downloaded.filename).toBe('quantum_sim_v1.py');
    expect(downloaded.versionNumber).toBe(1);
    expect(downloaded.size).toBe(80);
    expect(mockDriver.getStream).toHaveBeenCalledWith(v1Blob.s3Key);

    const reverted = await versionService.revertVersion(fileId, 1, 'user-1');
    expect(reverted).toMatchObject({
      revertedToVersion: 1,
      newVersionNumber: 3,
      blobId: 'blob-v1',
    });
    expect(nodesInDb.get(fileId)?.blobId).toBe('blob-v1');
    const fileVersions = versionsInDb.get(fileId) ?? [];
    expect(fileVersions[fileVersions.length - 1]?.changeComment).toBe(
      'Reverted to version 1',
    );
  });
});
