import { Readable } from 'node:stream';
import { PrismaService } from '@/core';
import {
  DuplicateNodePathError,
  InvalidNodeNameError,
  CyclicMoveError,
  NodeNotFoundError,
  NodePathVo,
  ManuscriptNodeEntity,
  IStructureRepository,
} from '@/modules/pages/structure/domain';
import { StructureRepository } from '@/modules/pages/structure/structure.repository';
import { StructureService } from '@/modules/pages/structure/structure.service';
import {
  ManuscriptFile,
  ContentHash,
  StorageKey,
  DuplicateFileException,
  FilestoreValidationException,
  StorageQuotaExceededException,
  FileNotFoundException,
  InvalidByteRangeException,
} from '@/modules/pages/filestore/filestore.types';
import { ManuscriptFileResponseDto } from '@/modules/pages/filestore/dto/file-response.dto';
import { FilestoreRepository } from '@/modules/pages/filestore/filestore.repository';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import {
  filterRecordsByPageScope,
  findPageRecordWithNode,
  applyPageMetadataAndTitleUpdates,
} from '@/modules/pages/docstore/controllers/doc.helpers';
import {
  BlobService,
  StorageBlob,
  BlobStatus,
  ContentHash as PlatformContentHash,
  StorageKey as PlatformStorageKey,
} from '@/modules/storage/core';
import type { IStorageBlobRepository } from '@/modules/storage/core/repositories/prisma-blob.repository';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_B_ID = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '33333333-3333-4333-8333-333333333333';
const FILE_ID = '44444444-4444-4444-8444-444444444444';
const BLOB_OLD_ID = '55555555-5555-4555-8555-555555555555';
const BLOB_NEW_ID = '66666666-6666-4666-8666-666666666666';
const SHA1_HEX = 'a'.repeat(40);
const SHA256_OLD_HEX = 'b'.repeat(64);
const SHA256_NEW_HEX = 'c'.repeat(64);

describe('Khối 2 / Tầng 2 — Virtual Tree, Filestore CAS & Multi-Page Isolation', () => {
  describe('1. DTOs, Terminology & Domain Exception HTTP Status Codes', () => {
    it('exposes statusCode on all Filestore & Structure domain errors and rejects control characters', () => {
      expect(new FileNotFoundException(FILE_ID, SPACE_ID).statusCode).toBe(404);
      expect(new DuplicateFileException('fig.png', SPACE_ID).statusCode).toBe(
        409,
      );
      expect(new StorageQuotaExceededException(60, 50).statusCode).toBe(413);
      expect(new FilestoreValidationException('bad').statusCode).toBe(400);
      expect(new InvalidByteRangeException('bytes=99-100', 10).statusCode).toBe(
        416,
      );

      expect(new NodeNotFoundError('n1').statusCode).toBe(404);
      expect(new DuplicateNodePathError('/a').statusCode).toBe(409);
      expect(new CyclicMoveError('/a', '/a/b').statusCode).toBe(400);
      expect(new InvalidNodeNameError('bad').statusCode).toBe(400);

      expect(() => NodePathVo.validateFilename('bad\nname.tex')).toThrow(
        InvalidNodeNameError,
      );
      expect(() => ManuscriptFile.sanitizeFilename('bad\x1bfile.png')).toThrow(
        FilestoreValidationException,
      );
    });

    it('populates spaceId and pageId on ManuscriptFileResponseDto and ManuscriptNodeEntity', () => {
      const file = ManuscriptFile.reconstitute({
        id: FILE_ID,
        projectId: SPACE_ID,
        pageId: PAGE_B_ID,
        blobId: BLOB_OLD_ID,
        name: 'figures/plot.png',
        mimeType: 'image/png',
        sizeBytes: 256,
        hash: ContentHash.create(SHA1_HEX),
        storageKey: StorageKey.fromRawKey('blobs/plot'),
      });
      const dto = ManuscriptFileResponseDto.fromEntity(file);
      expect(dto.spaceId).toBe(SPACE_ID);
      expect(dto.projectId).toBe(SPACE_ID);
      expect(dto.pageId).toBe(PAGE_B_ID);

      const node = new ManuscriptNodeEntity({
        id: 'node-1',
        projectId: SPACE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_B_ID,
        type: 'FILE',
        name: 'plot.png',
        path: '/figures/plot.png',
        fileId: FILE_ID,
        blobId: BLOB_OLD_ID,
      });
      expect(node.spaceId).toBe(SPACE_ID);
      expect(node.blobId).toBe(BLOB_OLD_ID);
      expect(node.toJSON().spaceId).toBe(SPACE_ID);
      expect(node.toTreeNode().spaceId).toBe(SPACE_ID);
    });
  });

  describe('2. Default-Page (pageId === spaceId) Multi-Page Isolation', () => {
    it('keeps pageId scope when pageId equals spaceId across StructureRepository, FilestoreRepository, and filterRecordsByPageScope', async () => {
      const records = [
        { id: 'd1', pageId: SPACE_ID },
        { id: 'd2', pageId: PAGE_B_ID },
      ];
      expect(filterRecordsByPageScope(records, SPACE_ID, SPACE_ID)).toEqual([
        { id: 'd1', pageId: SPACE_ID },
      ]);

      const pageNodeFindMany = jest.fn().mockResolvedValue([]);
      const pageUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const mockPrisma = {
        pageNode: {
          findMany: pageNodeFindMany,
          deleteMany: jest.fn(),
        },
        page: {
          updateMany: pageUpdateMany,
        },
      } as unknown as PrismaService;

      const structureRepo = new StructureRepository(mockPrisma);
      await structureRepo.deleteSubtree(SPACE_ID, '/chapters', SPACE_ID);
      expect(pageNodeFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            spaceId: SPACE_ID,
            pageId: SPACE_ID,
          }),
        }),
      );

      await structureRepo.unsetRootDoc(SPACE_ID, SPACE_ID);
      expect(pageUpdateMany).toHaveBeenCalledWith({
        where: {
          spaceId: SPACE_ID,
          id: SPACE_ID,
          rootDocId: { not: null },
        },
        data: { rootDocId: null },
      });

      const pageFileFindFirst = jest.fn().mockResolvedValue(null);
      const filestoreRepo = new FilestoreRepository(
        {
          pageFile: { findFirst: pageFileFindFirst },
        } as unknown as PrismaService,
        {
          sendStream: jest.fn(),
          getObjectStream: jest.fn(),
          getObjectMetadata: jest.fn(),
          getSignedDownloadUrl: jest.fn(),
          checkObjectExists: jest.fn(),
          deleteObject: jest.fn(),
        },
      );
      await filestoreRepo.findByProjectAndName(SPACE_ID, 'fig.png', SPACE_ID);
      expect(pageFileFindFirst).toHaveBeenCalledWith({
        where: {
          spaceId: SPACE_ID,
          pageId: SPACE_ID,
          lastKnownPath: 'fig.png',
          deletedAt: null,
        },
      });
    });
  });

  describe('3. StructureService Guards & Subtree Move Limits', () => {
    it('rejects cross-page parentId and validates CyclicMoveError BEFORE creating folders with mkdirpInternal', async () => {
      const folderInPageA = new ManuscriptNodeEntity({
        id: 'folder-a',
        projectId: SPACE_ID,
        pageId: SPACE_ID,
        type: 'FOLDER',
        name: 'chapters',
        path: '/chapters',
      });
      const folderInPageB = new ManuscriptNodeEntity({
        id: 'folder-b',
        projectId: SPACE_ID,
        pageId: PAGE_B_ID,
        type: 'FOLDER',
        name: 'other',
        path: '/other',
      });

      const createNodeMock = jest.fn();
      const mockRepo: jest.Mocked<IStructureRepository> = {
        createNode: createNodeMock,
        findById: jest.fn(async (_s, id) => {
          if (id === 'folder-a') return folderInPageA;
          if (id === 'folder-b') return folderInPageB;
          return null;
        }),
        findByPath: jest.fn().mockResolvedValue(null),
        findByFileId: jest.fn().mockResolvedValue(null),
        getAllNodes: jest.fn().mockResolvedValue([]),
        getRootDoc: jest.fn().mockResolvedValue(null),
        setRootDoc: jest.fn(),
        unsetRootDoc: jest.fn(),
        moveSubtree: jest.fn(),
        renameNode: jest.fn(),
        deleteSubtree: jest.fn(),
        updateSortOrder: jest.fn(),
        countNodes: jest.fn().mockResolvedValue(2),
      };

      const service = new StructureService(mockRepo);

      // Cross-page parent attachment must fail cleanly without creating any node
      await expect(
        service.createNode(
          SPACE_ID,
          { name: 'sec1.tex', type: 'DOC', parentId: 'folder-b' },
          SPACE_ID,
        ),
      ).rejects.toThrow(InvalidNodeNameError);
      expect(createNodeMock).not.toHaveBeenCalled();

      // Cyclic move must fail before mkdirpInternal creates /chapters/sub/deep folders
      await expect(
        service.moveNode(SPACE_ID, 'folder-a', {
          destPath: '/chapters/sub/deep/chapters',
        }),
      ).rejects.toThrow(CyclicMoveError);
      expect(createNodeMock).not.toHaveBeenCalled();
    });

    it('rejects moveSubtree when rebased descendant path exceeds 1000 characters', async () => {
      const longSegment = 'a'.repeat(240);
      const deepChildPath = `/src/${longSegment}/${longSegment}/${longSegment}`;
      const mockPrisma = {
        $transaction: jest.fn(
          async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
            cb({
              pageNode: {
                findFirst: jest.fn().mockResolvedValue({
                  id: 'folder-src',
                  spaceId: SPACE_ID,
                  pageId: PAGE_B_ID,
                  path: '/src',
                  depth: 1,
                }),
                update: jest.fn().mockResolvedValue({
                  id: 'folder-src',
                  spaceId: SPACE_ID,
                  pageId: PAGE_B_ID,
                  path: `/${longSegment}/src`,
                  depth: 2,
                }),
                findMany: jest
                  .fn()
                  .mockResolvedValue([
                    { id: 'desc-1', path: deepChildPath, depth: 4 },
                  ]),
              },
              pageDoc: { updateMany: jest.fn() },
              pageFile: { updateMany: jest.fn() },
            }),
        ),
      } as unknown as PrismaService;

      const repo = new StructureRepository(mockPrisma);
      await expect(
        repo.moveSubtree(SPACE_ID, '/src', `/${'x'.repeat(300)}`, null, {
          nodeId: 'folder-src',
          pageId: PAGE_B_ID,
        }),
      ).rejects.toThrow(InvalidNodeNameError);
    });
  });

  describe('4. Filestore CAS RefCount, Collision Guard, Restore & Tombstone Revival', () => {
    it('releases blobId on subtree delete even with 40-char SHA-1 PageFile.hash, and acquires blob on restoreFile', async () => {
      const releaseBlob = jest.fn().mockResolvedValue(undefined);
      const acquireBlob = jest.fn().mockResolvedValue(null);
      const saveMock = jest.fn(async (f: ManuscriptFile) => f);
      const findByProjectAndId = jest.fn().mockResolvedValue(
        ManuscriptFile.reconstitute({
          id: FILE_ID,
          projectId: SPACE_ID,
          pageId: PAGE_B_ID,
          blobId: BLOB_OLD_ID,
          name: 'fig.png',
          mimeType: 'image/png',
          sizeBytes: 512,
          hash: ContentHash.create(SHA1_HEX),
          storageKey: StorageKey.fromRawKey('blobs/fig'),
          deleted: true,
          deletedAt: new Date(),
        }),
      );

      const service = new FilestoreService(
        {
          findByProjectAndId,
          save: saveMock,
        } as unknown as FilestoreRepository,
        undefined,
        {
          releaseBlob,
          acquireBlob,
          findBlobByHash: jest.fn(),
        } as unknown as BlobService,
      );

      await service.reclaimDeletedFilesQuotaAndBlobs(
        SPACE_ID,
        [FILE_ID],
        [
          {
            fileId: FILE_ID,
            blobId: BLOB_OLD_ID,
            sizeBytes: 512,
            hash: SHA1_HEX,
          },
        ],
      );
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_OLD_ID);

      await service.restoreFile(SPACE_ID, FILE_ID);
      expect(acquireBlob).toHaveBeenCalledWith(BLOB_OLD_ID);
    });

    it('rejects DOC/FOLDER path collisions before quota/upload while destroying spool stream, and releases old blob on overwrite', async () => {
      const dataStream = Readable.from(Buffer.from('payload'));
      const destroySpy = jest.spyOn(dataStream, 'destroy');
      const incrementUsage = jest.fn();

      const collidingRepo = {
        resolvePageId: jest.fn(async () => PAGE_B_ID),
        hashStream: jest.fn(async () => ({
          contentHash: ContentHash.create(SHA1_HEX),
          sha256Hex: SHA256_NEW_HEX,
          sizeBytes: 7,
          dataStream,
        })),
        assertUploadPathAvailable: jest
          .fn()
          .mockRejectedValue(new DuplicateFileException('main.tex', SPACE_ID)),
        findByProjectAndName: jest.fn(),
      } as unknown as FilestoreRepository;

      const collidingService = new FilestoreService(
        collidingRepo,
        undefined,
        undefined,
        { incrementUsage, decrementUsage: jest.fn() } as never,
      );

      await expect(
        collidingService.uploadFileFromStream(
          SPACE_ID,
          'main.tex',
          Readable.from(Buffer.from('payload')),
          'application/octet-stream',
          'manuscript-files',
          { pageId: PAGE_B_ID },
        ),
      ).rejects.toThrow(DuplicateFileException);
      expect(incrementUsage).not.toHaveBeenCalled();
      expect(destroySpy).toHaveBeenCalled();

      // Overwrite with different content releases superseded blobId
      const existingFile = ManuscriptFile.reconstitute({
        id: FILE_ID,
        projectId: SPACE_ID,
        pageId: PAGE_B_ID,
        blobId: BLOB_OLD_ID,
        name: 'fig.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        hash: ContentHash.create(SHA1_HEX),
        storageKey: StorageKey.fromRawKey('blobs/old'),
      });
      const releaseBlob = jest.fn().mockResolvedValue(undefined);
      const overwriteService = new FilestoreService(
        {
          resolvePageId: jest.fn(async () => PAGE_B_ID),
          hashStream: jest.fn(async () => ({
            contentHash: ContentHash.create('f'.repeat(40)),
            sha256Hex: SHA256_NEW_HEX,
            sizeBytes: 120,
            dataStream: Readable.from(Buffer.from('new')),
          })),
          assertUploadPathAvailable: jest.fn().mockResolvedValue(undefined),
          findByProjectAndName: jest.fn().mockResolvedValue(existingFile),
          buildStorageKey: jest.fn(() => StorageKey.fromRawKey('blobs/new')),
          checkObjectExists: jest.fn().mockResolvedValue(true),
          save: jest.fn(async (f: ManuscriptFile) => f),
        } as unknown as FilestoreRepository,
        undefined,
        {
          findBlobByHash: jest.fn().mockResolvedValue(null),
          registerUploadedObject: jest.fn().mockResolvedValue({
            blob: {
              id: BLOB_NEW_ID,
              s3Key: { value: () => 'blobs/cas/new' },
            },
          }),
          releaseBlob,
        } as unknown as BlobService,
      );

      const overwritten = await overwriteService.uploadFileFromStream(
        SPACE_ID,
        'fig.png',
        Readable.from(Buffer.from('new')),
        'image/png',
        'manuscript-files',
        { pageId: PAGE_B_ID },
      );
      expect(overwritten.blobId).toBe(BLOB_NEW_ID);
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_OLD_ID);
    });

    it('re-hydrates tombstoned CAS blob physical key during registerUploadedObject when previously deleted', async () => {
      const deletedBlob = new StorageBlob({
        id: BLOB_OLD_ID,
        contentHash: PlatformContentHash.fromHex(SHA256_OLD_HEX),
        sizeBytes: 12n,
        s3Key: PlatformStorageKey.fromString('blobs/canonical-sha256'),
        s3Bucket: 'flux',
        status: BlobStatus.DELETED,
        refCount: 0,
        tombstoneAt: new Date(Date.now() + 3600_000),
      });

      const driver = {
        stat: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
        getStream: jest.fn().mockResolvedValue({
          stream: Readable.from(Buffer.from('hello-cas')),
          contentLength: 9,
        }),
        put: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      };
      const blobRepo: jest.Mocked<IStorageBlobRepository> = {
        findById: jest.fn(),
        findByHash: jest.fn().mockResolvedValue(deletedBlob),
        create: jest.fn(),
        delete: jest.fn(),
        findTombstonedBlobs: jest.fn(),
        incrementRefCount: jest.fn().mockResolvedValue(deletedBlob),
        decrementRefCount: jest.fn(),
      };

      const blobService = new BlobService(driver as never, blobRepo);
      const res = await blobService.registerUploadedObject({
        storageKey: 'blobs/new-git-sha1',
        sizeBytes: 9n,
        contentHashHex: SHA256_OLD_HEX,
      });

      expect(res.isDeduplicated).toBe(true);
      expect(driver.put).toHaveBeenCalledWith(
        'blobs/canonical-sha256',
        expect.anything(),
        { size: 9 },
      );
      expect(driver.delete).toHaveBeenCalledWith('blobs/new-git-sha1');
      expect(blobRepo.incrementRefCount).toHaveBeenCalledWith(BLOB_OLD_ID);
    });
  });

  describe('5. Root Document Page Isolation & Display Title Preservation', () => {
    it('prevents cross-page content hijack in findPageRecordWithNode and preserves .tex extension on display title update', async () => {
      const pageFindFirst = jest.fn();
      const mockPrisma = {
        pageDoc: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        page: {
          findUnique: jest.fn().mockResolvedValue({
            id: PAGE_B_ID,
            spaceId: SPACE_ID,
            rootDocId: null,
            deletedAt: null,
          }),
          findFirst: pageFindFirst,
        },
      } as unknown as PrismaService;

      const resolved = await findPageRecordWithNode(
        mockPrisma,
        PAGE_B_ID,
        SPACE_ID,
      );
      expect(resolved).toBeNull();
      expect(pageFindFirst).not.toHaveBeenCalled();

      const pageNodeUpdateMany = jest.fn();
      const pageDocUpdate = jest.fn();
      const pageUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const titlePrisma = {
        pageNode: { updateMany: pageNodeUpdateMany },
        pageDoc: { update: pageDocUpdate },
        page: { updateMany: pageUpdateMany },
      } as unknown as PrismaService;

      await applyPageMetadataAndTitleUpdates(
        titlePrisma,
        DOC_ID,
        {
          spaceId: SPACE_ID,
          lastKnownPath: 'main.tex',
          ranges: {},
        },
        { title: 'Deep Learning Survey' },
      );

      expect(pageNodeUpdateMany).not.toHaveBeenCalled();
      expect(pageDocUpdate).not.toHaveBeenCalled();
      expect(pageUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { title: 'Deep Learning Survey' },
        }),
      );
    });
  });
});
