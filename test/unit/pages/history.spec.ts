import { Readable } from 'node:stream';
import { ZipAdapter } from '@/modules/pages/export-import';
import {
  DuplicateLabelException,
  EmptyProjectException,
  MaintenanceService,
  RestoreService,
  SnapshotService,
  VersionNotFoundException,
} from '@/modules/pages/history';
import { SnapshotCollectorAdapter } from '@/modules/pages/history/adapters/collector.adapter';
import { SnapshotRestorerAdapter } from '@/modules/pages/history/adapters/restorer.adapter';
import {
  InvalidVersionLabelException,
  VersionLabel,
} from '@/modules/pages/history/domain/label';
import {
  FileSnapshotVo,
  Snapshot,
} from '@/modules/pages/history/domain/snapshot';
import {
  HistoryMapper,
  HistoryRepository,
} from '@/modules/pages/history/history.repository';

const SPACE_ID = '0195f000-0000-7000-8000-000000000010';
const PAGE_A_ID = '0195f000-0000-7000-8000-000000000020';
const PAGE_B_ID = '0195f000-0000-7000-8000-000000000021';
const DOC_ID = '0195f000-0000-7000-8000-000000000029';
const FILE_ID = '0195f000-0000-7000-8000-000000000030';
const AUTHOR_ID = '0195f000-0000-7000-8000-000000000039';
const BLOB_V1_ID = '0195f000-0000-7000-8000-000000000041';
const BLOB_V2_ID = '0195f000-0000-7000-8000-000000000042';
const HASH_V1 = '1'.repeat(40);
const HASH_V2 = '2'.repeat(40);
const KEY_V1 = `blobs/11/11/${'1'.repeat(36)}`;
const KEY_V2 = `blobs/22/22/${'2'.repeat(36)}`;

describe('Pages History, CAS Pinning & Restore Seam', () => {
  describe('Domain errors & multi-page entity scoping', () => {
    it('exposes accurate HTTP statusCode values and preserves spaceId/pageId on Snapshot & VersionLabel', () => {
      expect(new VersionNotFoundException(SPACE_ID, 7).statusCode).toBe(404);
      expect(new DuplicateLabelException(SPACE_ID, 'v1.0').statusCode).toBe(
        409,
      );
      expect(new EmptyProjectException(SPACE_ID).statusCode).toBe(400);
      expect(new InvalidVersionLabelException().statusCode).toBe(400);

      const snap = HistoryMapper.toDomainHeader({
        id: 'snap-1',
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        version: 3,
        summary: 'Milestone A',
        createdById: AUTHOR_ID,
        isAutomatic: false,
        createdAt: new Date('2026-10-01T12:00:00Z'),
        _count: { files: 1 },
      });
      const label = VersionLabel.create({
        projectId: SPACE_ID,
        pageId: PAGE_B_ID,
        snapshotId: 'snap-2',
        version: 4,
        label: 'Camera Ready',
        createdById: AUTHOR_ID,
      });

      expect(snap.spaceId).toBe(SPACE_ID);
      expect(snap.pageId).toBe(PAGE_A_ID);
      expect(snap.fileCount).toBe(1);
      expect(label.spaceId).toBe(SPACE_ID);
      expect(label.pageId).toBe(PAGE_B_ID);
    });
  });

  describe('Immutable binary CAS pinning & historical ZIP streaming', () => {
    it('pins storageKey + contentHash on HistoryBlob and acquires FileBlob CAS ref on saveSnapshot', async () => {
      const createdBlobs: Array<Record<string, unknown>> = [];
      const acquireBlob = jest.fn().mockResolvedValue({ id: BLOB_V1_ID });

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

      const filesMap = await collector.collectCurrentState(SPACE_ID, PAGE_A_ID);
      const repo = new HistoryRepository(
        {
          page: {
            findUnique: jest.fn().mockResolvedValue({
              id: PAGE_A_ID,
              spaceId: SPACE_ID,
              deletedAt: null,
            }),
          },
          historyBlob: {
            findMany: jest.fn().mockResolvedValue([]),
            create: jest.fn(async ({ data }) => {
              createdBlobs.push(data);
              return data;
            }),
            createMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          fileBlob: {
            findFirst: jest.fn().mockResolvedValue({ id: BLOB_V1_ID }),
          },
          pageSnapshot: {
            create: jest.fn(async ({ data }) => ({
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
        } as never,
        { acquireBlob } as never,
      );

      const saved = await repo.saveSnapshot(
        Snapshot.create({
          projectId: SPACE_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
          version: 1,
          summary: 'v1 figure',
          files: filesMap,
        }),
      );

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
        pageId: PAGE_A_ID,
        version: 1,
        files: new Map([
          [
            '/figure.png',
            FileSnapshotVo.createFile(
              '/figure.png',
              FILE_ID,
              HASH_V1,
              v1Bytes.length,
              KEY_V1,
            ),
          ],
        ]),
      });

      const { zipStream } = collector.createSnapshotZipStream(
        SPACE_ID,
        v1Snapshot,
      );
      const chunks: Buffer[] = [];
      for await (const c of zipStream) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }

      const extracted = await new ZipAdapter().extractZip(
        Buffer.concat(chunks),
      );
      expect(extracted).toHaveLength(1);
      expect(extracted[0].path).toBe('figure.png');
      expect(extracted[0].data.equals(v1Bytes)).toBe(true);
      expect(openReadStream).not.toHaveBeenCalled();
    });
  });

  describe('Non-destructive restore, single-event tree broadcast & orphan GC', () => {
    it('forwards pageId on RestoreService.restoreSingleFile and records a non-destructive new version', async () => {
      const targetSnapshot = Snapshot.create({
        id: 'snap-v2',
        projectId: SPACE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        version: 2,
        summary: 'v2',
        createdById: AUTHOR_ID,
        files: new Map([
          [
            '/chapter1.tex',
            FileSnapshotVo.createDoc(
              '/chapter1.tex',
              DOC_ID,
              ['Restored line'],
              'hash-v2',
              false,
            ),
          ],
        ]),
      });

      const mockRepo = {
        findByVersion: jest.fn().mockResolvedValue(targetSnapshot),
        getLatestVersion: jest.fn().mockResolvedValue(4),
        saveSnapshot: jest.fn(async (s: Snapshot) => s),
      } as unknown as HistoryRepository;
      const mockCollector = {
        collectCurrentState: jest.fn().mockResolvedValue(
          new Map([
            [
              '/chapter1.tex',
              FileSnapshotVo.createDoc(
                '/chapter1.tex',
                DOC_ID,
                ['Restored line'],
                'hash-new',
                false,
              ),
            ],
          ]),
        ),
      } as unknown as SnapshotCollectorAdapter;
      const mockRestorer = {
        restoreSingleFileToState: jest.fn().mockResolvedValue({
          path: '/chapter1.tex',
          docId: DOC_ID,
          fileId: null,
          content: 'Restored line',
          rev: 12,
        }),
      } as unknown as SnapshotRestorerAdapter;

      const service = new RestoreService(
        mockRepo,
        mockRestorer,
        new SnapshotService(mockRepo, mockCollector),
      );

      const res = await service.restoreSingleFile(
        SPACE_ID,
        2,
        { pathname: '/chapter1.tex', pageId: PAGE_A_ID },
        AUTHOR_ID,
        PAGE_A_ID,
      );

      expect(mockRepo.findByVersion).toHaveBeenCalledWith(
        SPACE_ID,
        2,
        PAGE_A_ID,
      );
      expect(res).toMatchObject({
        path: '/chapter1.tex',
        version: 2,
        newVersion: 5,
        docId: DOC_ID,
        rev: 12,
      });
    });

    it('restores overwritten PageFile to pinned v1 CAS blob/quota and emits ONE consolidated fileTree:update event', async () => {
      let pageFileRow = {
        id: FILE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
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
      const broadcastFileTreeChange = jest.fn();
      const deleteSubtree = jest.fn().mockResolvedValue([]);

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
            {
              id: 'stale-1',
              name: 'stale1.tex',
              path: '/stale1.tex',
              type: 'DOC',
              docId: 'doc-stale-1',
              isFolder: () => false,
              isDoc: () => true,
            },
          ]),
          updateNodeFileId: jest.fn().mockResolvedValue({}),
          deleteNode: jest.fn(),
          createNode: jest.fn(),
        } as never,
        {} as never,
        undefined,
        {
          pageFile: {
            findFirst: jest.fn(async () => ({ ...pageFileRow })),
            updateMany: jest.fn(async ({ data }) => {
              pageFileRow = { ...pageFileRow, ...data };
              return { count: 1 };
            }),
          },
          fileBlob: {
            findFirst: jest.fn(
              async ({ where }: { where: { storageKey?: string } }) =>
                where.storageKey === KEY_V1 ? { id: BLOB_V1_ID } : null,
            ),
          },
        } as never,
        undefined,
        undefined,
        {
          getLatestVersion: jest.fn().mockResolvedValue(2),
          saveSnapshot: jest.fn(async (s: Snapshot) => s),
          findBlobInSpace: jest.fn().mockResolvedValue(null),
        } as never,
        {} as never,
        {
          collectCurrentState: jest.fn().mockResolvedValue(
            new Map([
              [
                '/figure.png',
                FileSnapshotVo.createFile(
                  '/figure.png',
                  FILE_ID,
                  HASH_V2,
                  250,
                  KEY_V2,
                  BLOB_V2_ID,
                ),
              ],
            ]),
          ),
        } as never,
        { acquireBlob, releaseBlob, releaseQuota } as never,
        {
          deleteSubtree,
          createNode: jest.fn().mockResolvedValue({ id: 'node-restored' }),
          setRootDoc: jest.fn().mockResolvedValue(undefined),
          findByPath: jest.fn().mockResolvedValue(null),
          updateNodeFileId: jest.fn().mockResolvedValue({}),
        } as never,
        { broadcastFileTreeChange } as never,
      );

      const v1Snapshot = Snapshot.create({
        projectId: SPACE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        version: 1,
        files: new Map([
          [
            '/figure.png',
            FileSnapshotVo.createFile(
              '/figure.png',
              FILE_ID,
              HASH_V1,
              100,
              KEY_V1,
            ),
          ],
        ]),
      });

      const result = await restorer.restoreToState(
        SPACE_ID,
        v1Snapshot,
        PAGE_A_ID,
      );

      expect(result.restoredFilesCount).toBe(1);
      expect(pageFileRow).toMatchObject({
        storageKey: KEY_V1,
        hash: HASH_V1,
        sizeBytes: 100,
        blobId: BLOB_V1_ID,
        deletedAt: null,
      });
      expect(acquireBlob).toHaveBeenCalledWith(BLOB_V1_ID);
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_V2_ID);
      expect(releaseQuota).toHaveBeenCalledWith(SPACE_ID, 150n);
      expect(deleteSubtree).toHaveBeenCalledTimes(1);
      expect(broadcastFileTreeChange).toHaveBeenCalledTimes(1);
      expect(broadcastFileTreeChange).toHaveBeenCalledWith(SPACE_ID, {
        action: 'restore',
        node: { pageId: PAGE_A_ID, version: 1 },
      });
    });

    it('releases FileBlob CAS ref when MaintenanceService GCs orphan binary HistoryBlobs', async () => {
      const releaseBlob = jest.fn().mockResolvedValue(undefined);
      let binaryDeleted = false;

      const repo = new HistoryRepository(
        {
          pageSnapshot: { findMany: jest.fn().mockResolvedValue([]) },
          historyBlob: {
            findMany: jest
              .fn()
              .mockResolvedValue([
                { contentHash: HASH_V2, storageKey: KEY_V2 },
              ]),
            deleteMany: jest.fn(
              async ({ where }: { where: { contentHash?: string } }) => {
                if (where.contentHash === HASH_V2 && !binaryDeleted) {
                  binaryDeleted = true;
                  return { count: 1 };
                }
                return { count: 0 };
              },
            ),
          },
          fileBlob: {
            findFirst: jest.fn().mockResolvedValue({ id: BLOB_V2_ID }),
          },
        } as never,
        { releaseBlob } as never,
      );

      const maintenance = new MaintenanceService(
        new SnapshotService(repo, {} as never),
      );
      const out = await maintenance.runMaintenance(30);

      expect(out.deletedOrphanBlobs).toBe(1);
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_V2_ID);
    });
  });
});
