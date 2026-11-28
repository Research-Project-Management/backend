import { Readable } from 'node:stream';
import { ZipAdapter } from '@/modules/pages/export-import';
import { HistoryRepository } from '@/modules/pages/history/history.repository';
import { SnapshotCollectorAdapter } from '@/modules/pages/history/adapters/collector.adapter';
import { SnapshotRestorerAdapter } from '@/modules/pages/history/adapters/restorer.adapter';
import { SnapshotService } from '@/modules/pages/history/services/snapshot.service';
import { MaintenanceService } from '@/modules/pages/history/services/maintenance.service';
import { FileSnapshotVo, Snapshot } from '@/modules/pages/history/domain/snapshot';

const SPACE_ID = '0195f000-0000-7000-8000-000000000010';
const PAGE_ID = '0195f000-0000-7000-8000-000000000020';
const FILE_ID = '0195f000-0000-7000-8000-000000000030';
const BLOB_V1_ID = '0195f000-0000-7000-8000-000000000041';
const BLOB_V2_ID = '0195f000-0000-7000-8000-000000000042';
const HASH_V1 = '1'.repeat(40);
const HASH_V2 = '2'.repeat(40);
const KEY_V1 = `blobs/11/11/${'1'.repeat(36)}`;
const KEY_V2 = `blobs/22/22/${'2'.repeat(36)}`;

describe('History Immutable Binary CAS Pinning, ZIP Streaming, Restore & GC', () => {
  it('pins storageKey + contentHash on HistoryBlob and acquires FileBlob CAS ref on saveSnapshot', async () => {
    const createdBlobs: Array<Record<string, unknown>> = [];
    const acquireBlob = jest.fn().mockResolvedValue({ id: BLOB_V1_ID });

    const mockPrisma = {
      page: {
        findUnique: jest.fn().mockResolvedValue({
          id: PAGE_ID,
          spaceId: SPACE_ID,
          deletedAt: null,
        }),
      },
      historyBlob: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }) => {
          createdBlobs.push(data);
          return data;
        }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fileBlob: {
        findFirst: jest.fn().mockResolvedValue({ id: BLOB_V1_ID }),
      },
      pageSnapshot: {
        create: jest.fn().mockImplementation(async ({ data }) => ({
          ...data,
          files: [
            {
              id: 'sf-1',
              snapshotId: data.id,
              pathname: '/figure.png',
              kind: 'file',
              isRoot: false,
              entityId: FILE_ID,
              contentHash: `${HASH_V1}                        `,
              blob: {
                contentHash: `${HASH_V1}                        `,
                content: null,
                sizeBytes: 128,
                inStorage: true,
                storageKey: KEY_V1,
              },
            },
          ],
          labels: [],
        })),
      },
    };

    const collector = new SnapshotCollectorAdapter(
      {
        getAllNodes: jest.fn().mockResolvedValue([
          {
            id: 'node-fig',
            path: '/figure.png',
            type: 'FILE',
            fileId: FILE_ID,
            isFolder: () => false,
            isDoc: () => false,
          },
        ]),
      } as never,
      {} as never,
      {
        getFileMetadata: jest.fn().mockResolvedValue({
          id: FILE_ID,
          blobId: BLOB_V1_ID,
          sizeBytes: 128,
          hash: { getValue: () => HASH_V1 },
          storageKey: { getValue: () => KEY_V1 },
        }),
      } as never,
    );

    const filesMap = await collector.collectCurrentState(SPACE_ID, PAGE_ID);
    const collectedFig = filesMap.get('/figure.png');
    expect(collectedFig?.storageKey).toBe(KEY_V1);
    expect(collectedFig?.hash).toBe(HASH_V1);

    const repo = new HistoryRepository(
      mockPrisma as never,
      { acquireBlob } as never,
    );

    const snap = Snapshot.create({
      projectId: SPACE_ID,
      spaceId: SPACE_ID,
      pageId: PAGE_ID,
      version: 1,
      summary: 'v1 figure',
      files: filesMap,
    });

    const saved = await repo.saveSnapshot(snap);

    expect(createdBlobs).toEqual([
      {
        contentHash: HASH_V1,
        content: null,
        sizeBytes: 128,
        inStorage: true,
        storageKey: KEY_V1,
      },
    ]);
    expect(acquireBlob).toHaveBeenCalledWith(BLOB_V1_ID);
    expect(saved.getFile('/figure.png')?.storageKey).toBe(KEY_V1);
    expect(saved.getFile('/figure.png')?.hash).toBe(HASH_V1);
  });

  it('streams historical ZIP directly from pinned HistoryBlob.storageKey even after PageFile was overwritten', async () => {
    const v1Bytes = Buffer.from('PNG_V1_HISTORICAL_PAYLOAD', 'utf8');
    const v2Bytes = Buffer.from('PNG_V2_OVERWRITTEN_PAYLOAD', 'utf8');

    const getObjectStream = jest.fn(async (_bucket: string, key: string) =>
      Readable.from(key === KEY_V1 ? v1Bytes : v2Bytes),
    );
    const openReadStream = jest.fn(async () => ({
      stream: Readable.from(v2Bytes),
    }));

    const collector = new SnapshotCollectorAdapter(
      {} as never,
      {} as never,
      { openReadStream } as never,
      undefined,
      { getObjectStream } as never,
    );

    const v1Snapshot = Snapshot.create({
      projectId: SPACE_ID,
      spaceId: SPACE_ID,
      pageId: PAGE_ID,
      version: 1,
      files: new Map([
        [
          '/figure.png',
          FileSnapshotVo.createFile('/figure.png', FILE_ID, HASH_V1, v1Bytes.length, KEY_V1),
        ],
      ]),
    });

    const { zipStream } = collector.createSnapshotZipStream(SPACE_ID, v1Snapshot);
    const chunks: Buffer[] = [];
    for await (const c of zipStream) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }

    const zip = new ZipAdapter();
    const extracted = await zip.extractZip(Buffer.concat(chunks));
    expect(extracted).toHaveLength(1);
    expect(extracted[0].path).toBe('figure.png');
    expect(extracted[0].data.equals(v1Bytes)).toBe(true);
    expect(getObjectStream).toHaveBeenCalledWith('manuscript-files', KEY_V1);
    expect(openReadStream).not.toHaveBeenCalled();
  });

  it('restores PageFile to pinned v1 storageKey/hash/blobId when figure.png was overwritten in v2', async () => {
    let pageFileRow = {
      id: FILE_ID,
      spaceId: SPACE_ID,
      pageId: PAGE_ID,
      blobId: BLOB_V2_ID,
      storageKey: KEY_V2,
      hash: HASH_V2,
      sizeBytes: 250,
      rev: 2,
      deletedAt: null as Date | null,
    };

    const acquireBlob = jest.fn().mockResolvedValue({ id: BLOB_V1_ID });
    const releaseBlob = jest.fn().mockResolvedValue(undefined);
    const releaseQuota = jest.fn().mockResolvedValue(0n);

    const mockPrisma = {
      pageFile: {
        findFirst: jest.fn(async () => ({ ...pageFileRow })),
        updateMany: jest.fn(async ({ data }) => {
          pageFileRow = { ...pageFileRow, ...data };
          return { count: 1 };
        }),
      },
      fileBlob: {
        findFirst: jest.fn(async ({ where }: { where: { storageKey?: string } }) =>
          where.storageKey === KEY_V1
            ? { id: BLOB_V1_ID }
            : where.storageKey === KEY_V2
              ? { id: BLOB_V2_ID }
              : null,
        ),
      },
    };

    const mockHistoryRepo = {
      getLatestVersion: jest.fn().mockResolvedValue(2),
      saveSnapshot: jest.fn(async (s: Snapshot) => s),
      findBlobInSpace: jest.fn().mockResolvedValue(null),
    };

    const mockCollector = {
      collectCurrentState: jest.fn().mockResolvedValue(
        new Map([
          [
            '/figure.png',
            FileSnapshotVo.createFile('/figure.png', FILE_ID, HASH_V2, 250, KEY_V2, BLOB_V2_ID),
          ],
        ]),
      ),
    };

    const updateNodeFileId = jest.fn().mockResolvedValue({});
    const restorer = new SnapshotRestorerAdapter(
      {
        getAllNodes: jest.fn().mockResolvedValue([
          {
            id: 'node-fig',
            name: 'figure.png',
            path: '/figure.png',
            type: 'FILE',
            fileId: FILE_ID,
            isFolder: () => false,
            isDoc: () => false,
          },
        ]),
        updateNodeFileId,
      } as never,
      {} as never,
      undefined,
      mockPrisma as never,
      undefined,
      undefined,
      mockHistoryRepo as never,
      {} as never,
      mockCollector as never,
      { acquireBlob, releaseBlob, releaseQuota } as never,
    );

    const v1Snapshot = Snapshot.create({
      projectId: SPACE_ID,
      spaceId: SPACE_ID,
      pageId: PAGE_ID,
      version: 1,
      files: new Map([
        [
          '/figure.png',
          FileSnapshotVo.createFile('/figure.png', FILE_ID, HASH_V1, 100, KEY_V1),
        ],
      ]),
    });

    const result = await restorer.restoreToState(SPACE_ID, v1Snapshot, PAGE_ID);

    expect(result.restoredFilesCount).toBe(1);
    expect(mockCollector.collectCurrentState).toHaveBeenCalledWith(SPACE_ID, PAGE_ID);
    expect(mockHistoryRepo.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(pageFileRow.storageKey).toBe(KEY_V1);
    expect(pageFileRow.hash).toBe(HASH_V1);
    expect(pageFileRow.sizeBytes).toBe(100);
    expect(pageFileRow.blobId).toBe(BLOB_V1_ID);
    expect(pageFileRow.deletedAt).toBeNull();
    expect(acquireBlob).toHaveBeenCalledWith(BLOB_V1_ID);
    expect(releaseBlob).toHaveBeenCalledWith(BLOB_V2_ID);
    expect(releaseQuota).toHaveBeenCalledWith(SPACE_ID, 150n);
  });

  it('releases FileBlob CAS ref when MaintenanceService GCs orphan binary HistoryBlobs', async () => {
    const releaseBlob = jest.fn().mockResolvedValue(undefined);
    let binaryDeleted = false;

    const mockPrisma = {
      pageSnapshot: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      historyBlob: {
        findMany: jest.fn().mockResolvedValue([
          { contentHash: HASH_V2, storageKey: KEY_V2 },
        ]),
        deleteMany: jest.fn(async ({ where }: { where: { contentHash?: string } }) => {
          if (where.contentHash === HASH_V2 && !binaryDeleted) {
            binaryDeleted = true;
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      fileBlob: {
        findFirst: jest.fn().mockResolvedValue({ id: BLOB_V2_ID }),
      },
    };

    const repo = new HistoryRepository(
      mockPrisma as never,
      { releaseBlob } as never,
    );
    const snapshotSvc = new SnapshotService(repo, {} as never);
    const maintenance = new MaintenanceService(snapshotSvc);

    const out = await maintenance.runMaintenance(30);

    expect(out.deletedOrphanBlobs).toBe(1);
    expect(releaseBlob).toHaveBeenCalledWith(BLOB_V2_ID);
  });

  it('emits ONE consolidated fileTree:update event at the end of restoreToState via StructureRepository', async () => {
    const broadcastFileTreeChange = jest.fn();
    const deleteSubtree = jest.fn().mockResolvedValue([]);
    const createNode = jest.fn().mockResolvedValue({ id: 'node-restored' });
    const setRootDoc = jest.fn().mockResolvedValue(undefined);
    const structureService = {
      getAllNodes: jest.fn().mockResolvedValue([
        {
          id: 'stale-1',
          name: 'stale1.tex',
          path: '/stale1.tex',
          type: 'DOC',
          docId: 'doc-stale-1',
          isFolder: () => false,
          isDoc: () => true,
        },
        {
          id: 'stale-2',
          name: 'stale2.tex',
          path: '/stale2.tex',
          type: 'DOC',
          docId: 'doc-stale-2',
          isFolder: () => false,
          isDoc: () => true,
        },
      ]),
      deleteNode: jest.fn(),
      createNode: jest.fn(),
    };

    const restorer = new SnapshotRestorerAdapter(
      structureService as never,
      {
        createDoc: jest.fn().mockResolvedValue({ id: 'doc-main', rev: 1, version: 1 }),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        deleteSubtree,
        createNode,
        setRootDoc,
        findByPath: jest.fn().mockResolvedValue(null),
      } as never,
      { broadcastFileTreeChange } as never,
    );

    const snap = Snapshot.create({
      projectId: SPACE_ID,
      spaceId: SPACE_ID,
      pageId: PAGE_ID,
      version: 3,
      files: new Map([
        [
          '/main.tex',
          FileSnapshotVo.createDoc('/main.tex', null, ['\\section{Restored}'], 'h1', true),
        ],
      ]),
    });

    await restorer.restoreToState(SPACE_ID, snap, PAGE_ID);

    expect(deleteSubtree).toHaveBeenCalledTimes(2);
    expect(structureService.deleteNode).not.toHaveBeenCalled();
    expect(structureService.createNode).not.toHaveBeenCalled();
    expect(broadcastFileTreeChange).toHaveBeenCalledTimes(1);
    expect(broadcastFileTreeChange).toHaveBeenCalledWith(SPACE_ID, {
      action: 'restore',
      node: { pageId: PAGE_ID, version: 3 },
    });
  });
});
