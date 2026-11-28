import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { PrismaService } from '@/core';
import {
  ContentHash as PlatformContentHash,
  StorageKey as PlatformStorageKey,
} from '@/modules/files/domain/storage.vo';
import { BlobRepository } from '@/modules/files/repositories/blob.repository';
import { BlobService } from '@/modules/files/services/blob.service';
import {
  BlobStatus,
  type IFilesPort,
  type StorageBlobRecord,
} from '@/modules/files/types/files.type';
import {
  NodePathVo,
  filterRecordsByPageScope,
  resolvePageControllerCoordinates,
} from '@/modules/pages/core';
import {
  ContentHash,
  DuplicateFileException,
  FileNotFoundException,
  FilestoreRepository,
  FilestoreService,
  FilestoreValidationException,
  InvalidByteRangeException,
  PageBinaryAsset,
  PageBinaryAssetResponseDto,
  StorageKey,
  StorageQuotaExceededException,
} from '@/modules/pages/filestore';
import {
  CyclicMoveError,
  DuplicateNodePathError,
  InvalidNodeNameError,
  LatexOutlineExtractor,
  NodeNotFoundError,
  PageNodeEntity,
  StructureRepository,
  StructureService,
} from '@/modules/pages/structure';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';
const DOC_MAIN_ID = '33333333-3333-4333-8333-333333333333';
const DOC_CHILD_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const BLOB_OLD_ID = '66666666-6666-4666-8666-666666666666';
const BLOB_NEW_ID = '77777777-7777-4777-8777-777777777777';
const SHA1_HEX = 'a'.repeat(40);
const SHA256_OLD_HEX = crypto
  .createHash('sha256')
  .update('hello-cas')
  .digest('hex');
const SHA256_NEW_HEX = 'c'.repeat(64);

describe('Pages Structure & Filestore Seam', () => {
  describe('LatexOutlineExtractor', () => {
    it('extracts multi-line section titles, unescapes LaTeX tokens, and ignores inline comments', () => {
      const tex = [
        '\\section{A Very Long Title % inline comment',
        '  Continued on \\textbf{Next \\emph{Line}}}',
        '\\label{sec:long}',
        '\\section{R\\&D 100\\% \\_test\\#1 \\$50}',
        'Some text\\\\% \\section{Commented Out Heading}',
      ].join('\n');

      const entries = LatexOutlineExtractor.extractFromContent(tex, 'main.tex');
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        level: 'section',
        title: 'A Very Long Title Continued on Next Line',
        line: 1,
        label: 'sec:long',
      });
      expect(entries[1].title).toBe('R&D 100% _test#1 $50');
    });

    it('handles Beamer frames and builds part > chapter > section hierarchy while skipping verbatim/comment blocks', () => {
      const slides = [
        '\\begin{frame}<1-2>[fragile]{Overview of \\textbf{Flux \\emph{Editor}}}',
        'Body',
        '\\end{frame}',
        '\\begin{frame}',
        '\\frametitle[short]{Architecture \\& \\texttt{CLSI}}',
        '\\end{frame}',
      ].join('\n');

      expect(
        LatexOutlineExtractor.extractFromContent(slides, 'slides.tex').map(
          (e) => ({ level: e.level, title: e.title }),
        ),
      ).toEqual([
        { level: 'slide', title: 'Overview of Flux Editor' },
        { level: 'slide', title: 'Architecture & CLSI' },
      ]);

      const book = [
        '\\part{Foundations}',
        '\\chapter{Background}',
        '\\section{Intro} \\subsection{Details}',
        '\\begin{verbatim}',
        '\\section{Fake Verbatim Section}',
        '\\end{verbatim}',
        '\\begin{comment}',
        '\\section{Fake Comment Section}',
        '\\end{comment}',
      ].join('\n');

      const entries = LatexOutlineExtractor.extractFromContent(book, 'book.tex');
      expect(entries.map((e) => `${e.level}:${e.title}`)).toEqual([
        'part:Foundations',
        'chapter:Background',
        'section:Intro',
        'subsection:Details',
      ]);

      const tree = LatexOutlineExtractor.buildOutlineTree(entries);
      expect(tree).toHaveLength(1);
      expect(
        tree[0].children?.[0].children?.[0].children?.[0].level,
      ).toBe('subsection');
    });
  });

  describe('Domain errors, entities & multi-page scope coordinates', () => {
    it('exposes HTTP statusCode on domain errors, rejects control characters, and serializes spaceId/pageId', () => {
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
      expect(() => PageBinaryAsset.sanitizeFilename('bad\x1bfile.png')).toThrow(
        FilestoreValidationException,
      );

      const file = PageBinaryAsset.reconstitute({
        id: FILE_ID,
        projectId: SPACE_ID,
        pageId: PAGE_ID,
        blobId: BLOB_OLD_ID,
        name: 'figures/plot.png',
        mimeType: 'image/png',
        sizeBytes: 256,
        hash: ContentHash.create(SHA1_HEX),
        storageKey: StorageKey.fromRawKey('blobs/plot'),
      });
      const dto = PageBinaryAssetResponseDto.fromEntity(file);
      expect(dto.spaceId).toBe(SPACE_ID);
      expect(dto.pageId).toBe(PAGE_ID);

      const node = new PageNodeEntity({
        id: 'node-1',
        projectId: SPACE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        type: 'FILE',
        name: 'plot.png',
        path: '/figures/plot.png',
        fileId: FILE_ID,
        blobId: BLOB_OLD_ID,
      });
      expect(node.toJSON().spaceId).toBe(SPACE_ID);
      expect(node.toTreeNode().spaceId).toBe(SPACE_ID);
    });

    it('isolates default-page records when pageId === spaceId and resolves controller coordinates', () => {
      const records = [
        { id: 'd1', pageId: SPACE_ID },
        { id: 'd2', pageId: PAGE_ID },
      ];
      expect(filterRecordsByPageScope(records, SPACE_ID, SPACE_ID)).toEqual([
        { id: 'd1', pageId: SPACE_ID },
      ]);

      const coords = resolvePageControllerCoordinates(
        { spaceId: PAGE_ID },
        SPACE_ID,
        undefined,
        { resolvedSpaceId: SPACE_ID, resolvedPageId: PAGE_ID },
      );
      expect(coords).toEqual({ spaceId: SPACE_ID, pageId: PAGE_ID });
    });
  });

  describe('Virtual Tree hydration, root-doc SSOT & subtree invariants', () => {
    it('hydrates isRootDoc from Page.rootDocId and sizeBytes/hash from joined PageDoc/PageFile', async () => {
      const now = new Date('2026-06-01T00:00:00Z');
      const nodeRows = [
        {
          id: 'node-main',
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: null,
          type: 'DOC' as const,
          name: 'main.tex',
          path: '/main.tex',
          depth: 1,
          docId: DOC_MAIN_ID,
          fileId: null,
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
          doc: { sizeBytes: 512, hash: 'sha256-main' },
          file: null,
          page: { rootDocId: DOC_MAIN_ID },
        },
        {
          id: 'node-child',
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: null,
          type: 'DOC' as const,
          name: 'intro.tex',
          path: '/intro.tex',
          depth: 1,
          docId: DOC_CHILD_ID,
          fileId: null,
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
          doc: { sizeBytes: 1024, hash: 'sha256-child' },
          file: null,
          page: { rootDocId: DOC_MAIN_ID },
        },
        {
          id: 'node-fig',
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: null,
          type: 'FILE' as const,
          name: 'plot.png',
          path: '/plot.png',
          depth: 1,
          docId: null,
          fileId: FILE_ID,
          sortOrder: 2,
          createdAt: now,
          updatedAt: now,
          doc: null,
          file: { sizeBytes: 8192, hash: 'sha256-plot' },
          page: { rootDocId: DOC_MAIN_ID },
        },
      ];

      let currentRootDocId: string | null = DOC_MAIN_ID;
      const mockPrisma = {
        page: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
            where.id === PAGE_ID
              ? {
                  id: PAGE_ID,
                  spaceId: SPACE_ID,
                  rootDocId: currentRootDocId,
                  deletedAt: null,
                }
              : null,
          ),
          findFirst: jest.fn(async () => ({
            id: PAGE_ID,
            spaceId: SPACE_ID,
            rootDocId: currentRootDocId,
            deletedAt: null,
          })),
          updateMany: jest.fn(
            async ({ data }: { data: { rootDocId: string | null } }) => {
              currentRootDocId = data.rootDocId;
              for (const row of nodeRows) {
                row.page.rootDocId = data.rootDocId as string;
              }
              return { count: 1 };
            },
          ),
        },
        pageNode: {
          findMany: jest.fn(async () => nodeRows),
          findFirst: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) => {
              if (Array.isArray(where.OR)) {
                const ids = where.OR.map(
                  (c: Record<string, string>) => c.id || c.docId,
                );
                return (
                  nodeRows.find(
                    (r) =>
                      ids.includes(r.id) || (r.docId && ids.includes(r.docId)),
                  ) ?? null
                );
              }
              if (where.docId) {
                return nodeRows.find((r) => r.docId === where.docId) ?? null;
              }
              return nodeRows[0];
            },
          ),
        },
      } as unknown as PrismaService;

      const repo = new StructureRepository(mockPrisma);
      const nodes = await repo.getAllNodes(SPACE_ID, PAGE_ID);

      expect(nodes.find((n) => n.id === 'node-main')).toMatchObject({
        isRootDoc: true,
        sizeBytes: 512,
        hash: 'sha256-main',
      });
      expect(nodes.find((n) => n.id === 'node-child')).toMatchObject({
        isRootDoc: false,
        sizeBytes: 1024,
      });
      expect(nodes.find((n) => n.id === 'node-fig')).toMatchObject({
        isRootDoc: false,
        sizeBytes: 8192,
        hash: 'sha256-plot',
      });

      await repo.setRootDoc(SPACE_ID, 'node-child');
      const fetchedRoot = await repo.getRootDoc(SPACE_ID, PAGE_ID);
      expect(fetchedRoot?.id).toBe('node-child');
      expect(fetchedRoot?.isRootDoc).toBe(true);

      await repo.unsetRootDoc(SPACE_ID, PAGE_ID);
      expect(await repo.getRootDoc(SPACE_ID, PAGE_ID)).toBeNull();
    });

    it('syncs lastKnownPath on renameNode, blocks cross-page parent & cyclic moves, and enforces 1000-char path cap', async () => {
      const now = new Date('2026-06-01T00:00:00Z');
      const pageDocUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const renamePrisma = {
        $transaction: jest.fn(
          async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
            cb({
              pageNode: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                findFirst: jest.fn().mockResolvedValue({
                  id: 'node-main',
                  spaceId: SPACE_ID,
                  pageId: PAGE_ID,
                  parentId: null,
                  type: 'DOC',
                  name: 'paper.tex',
                  path: '/paper.tex',
                  depth: 1,
                  docId: DOC_MAIN_ID,
                  fileId: null,
                  sortOrder: 0,
                  createdAt: now,
                  updatedAt: now,
                  doc: { sizeBytes: 120, hash: 'h1' },
                  file: null,
                  page: { rootDocId: DOC_MAIN_ID },
                }),
              },
              pageDoc: { updateMany: pageDocUpdateMany },
              pageFile: { updateMany: jest.fn() },
            }),
        ),
      } as unknown as PrismaService;

      const renamed = await new StructureRepository(renamePrisma).renameNode(
        SPACE_ID,
        'node-main',
        'paper.tex',
        '/paper.tex',
      );
      expect(renamed.path).toBe('/paper.tex');
      expect(pageDocUpdateMany).toHaveBeenCalledWith({
        where: { id: DOC_MAIN_ID, spaceId: SPACE_ID },
        data: { lastKnownPath: 'paper.tex' },
      });

      // Cross-page parent attachment & cyclic move guards
      const folderInPageA = new PageNodeEntity({
        id: 'folder-a',
        projectId: SPACE_ID,
        pageId: SPACE_ID,
        type: 'FOLDER',
        name: 'chapters',
        path: '/chapters',
      });
      const folderInPageB = new PageNodeEntity({
        id: 'folder-b',
        projectId: SPACE_ID,
        pageId: PAGE_ID,
        type: 'FOLDER',
        name: 'other',
        path: '/other',
      });
      const createNodeMock = jest.fn();
      const service = new StructureService({
        createNode: createNodeMock,
        findById: jest.fn(async (_s: string, id: string) =>
          id === 'folder-a'
            ? folderInPageA
            : id === 'folder-b'
              ? folderInPageB
              : null,
        ),
        findByPath: jest.fn().mockResolvedValue(null),
        countNodes: jest.fn().mockResolvedValue(2),
      } as unknown as StructureRepository);

      await expect(
        service.createNode(
          SPACE_ID,
          { name: 'sec1.tex', type: 'DOC', parentId: 'folder-b' },
          SPACE_ID,
        ),
      ).rejects.toThrow(InvalidNodeNameError);
      await expect(
        service.moveNode(SPACE_ID, 'folder-a', {
          destPath: '/chapters/sub/deep/chapters',
        }),
      ).rejects.toThrow(CyclicMoveError);
      expect(createNodeMock).not.toHaveBeenCalled();

      // Rebased descendant path > 1000 chars rejected
      const longSegment = 'a'.repeat(240);
      const deepPrisma = {
        $transaction: jest.fn(
          async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
            cb({
              pageNode: {
                findFirst: jest.fn().mockResolvedValue({
                  id: 'folder-src',
                  spaceId: SPACE_ID,
                  pageId: PAGE_ID,
                  path: '/src',
                  depth: 1,
                }),
                update: jest.fn().mockResolvedValue({
                  id: 'folder-src',
                  spaceId: SPACE_ID,
                  pageId: PAGE_ID,
                  path: `/${longSegment}/src`,
                  depth: 2,
                }),
                findMany: jest.fn().mockResolvedValue([
                  {
                    id: 'desc-1',
                    path: `/src/${longSegment}/${longSegment}/${longSegment}`,
                    depth: 4,
                  },
                ]),
              },
              pageDoc: { updateMany: jest.fn() },
              pageFile: { updateMany: jest.fn() },
            }),
        ),
      } as unknown as PrismaService;

      await expect(
        new StructureRepository(deepPrisma).moveSubtree(
          SPACE_ID,
          '/src',
          `/${'x'.repeat(300)}`,
          null,
          { nodeId: 'folder-src', pageId: PAGE_ID },
        ),
      ).rejects.toThrow(InvalidNodeNameError);
    });
  });

  describe('Filestore CAS ref-counting, quota safety & tombstone revival', () => {
    it('pins CAS blobId on upload, retains ref on soft-delete, releases on purge, and avoids double-acquire on restore', async () => {
      const shaHex = 'b'.repeat(64);
      const now = new Date('2026-06-01T00:00:00Z');
      const mockPrisma = {
        page: {
          findUnique: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            spaceId: SPACE_ID,
            deletedAt: null,
          }),
        },
        pageFile: {
          upsert: jest.fn(
            async ({ create }: { create: Record<string, unknown> }) => ({
              ...create,
              createdAt: now,
              updatedAt: now,
            }),
          ),
          findFirst: jest.fn().mockResolvedValue(null),
          update: jest.fn().mockResolvedValue({}),
        },
        pageNode: {
          findFirst: jest.fn().mockResolvedValue(null),
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue({ id: 'node-fig' }),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      } as unknown as PrismaService;

      const repo = new FilestoreRepository(mockPrisma, {
        sendStream: jest.fn(),
        getObjectStream: jest.fn(),
        getObjectMetadata: jest.fn(),
        getSignedDownloadUrl: jest.fn(),
        checkObjectExists: jest.fn().mockResolvedValue(true),
        deleteObject: jest.fn(),
      });
      jest.spyOn(repo, 'hashStream').mockResolvedValue({
        contentHash: ContentHash.create(shaHex),
        sha256Hex: shaHex,
        sizeBytes: 128,
        dataStream: Readable.from(Buffer.alloc(128, 1)),
      });
      jest
        .spyOn(repo, 'buildStorageKey')
        .mockReturnValue(StorageKey.fromRawKey('blobs/bb/bb/rest'));

      const releaseBlob = jest.fn().mockResolvedValue(undefined);
      const acquireBlob = jest.fn().mockResolvedValue(null);
      const reserveQuota = jest.fn().mockResolvedValue(undefined);

      const service = new FilestoreService(repo, undefined, {
        registerUploadedObject: jest.fn().mockResolvedValue({
          blob: { id: BLOB_OLD_ID, s3Key: 'blobs/cas/diagram' },
        }),
        releaseBlob,
        acquireBlob,
        reserveQuota,
        findBlobByHash: jest.fn(),
      } as unknown as IFilesPort);

      const saved = await service.uploadFileFromStream(
        SPACE_ID,
        'figures/diagram.png',
        Readable.from(Buffer.alloc(128, 1)),
        'image/png',
        'manuscript-files',
        { pageId: PAGE_ID },
      );
      expect(saved.blobId).toBe(BLOB_OLD_ID);
      expect(saved.name).toBe('figures/diagram.png');

      // Soft-delete retains CAS ref for Trash restore
      const activeEntity = PageBinaryAsset.reconstitute({
        id: FILE_ID,
        projectId: SPACE_ID,
        pageId: PAGE_ID,
        blobId: BLOB_OLD_ID,
        name: 'figures/diagram.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        hash: ContentHash.create(SHA1_HEX),
        storageKey: StorageKey.fromRawKey('blobs/cas/diagram'),
      });
      jest
        .spyOn(repo, 'findByProjectAndId')
        .mockResolvedValueOnce(activeEntity);
      jest.spyOn(repo, 'save').mockImplementation(async (f) => f);

      await service.deleteFile(SPACE_ID, FILE_ID, false);
      expect(releaseBlob).not.toHaveBeenCalled();

      // Restore re-activates soft-deleted asset without double-acquiring blob or quota
      const deletedEntity = PageBinaryAsset.reconstitute({
        id: FILE_ID,
        projectId: SPACE_ID,
        pageId: PAGE_ID,
        blobId: BLOB_OLD_ID,
        name: 'figures/diagram.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        hash: ContentHash.create(SHA1_HEX),
        storageKey: StorageKey.fromRawKey('blobs/cas/diagram'),
        deleted: true,
        deletedAt: new Date(),
      });
      jest
        .spyOn(repo, 'findByProjectAndId')
        .mockResolvedValueOnce(deletedEntity);
      acquireBlob.mockClear();
      reserveQuota.mockClear();
      await service.restoreFile(SPACE_ID, FILE_ID);
      expect(acquireBlob).not.toHaveBeenCalled();
      expect(reserveQuota).not.toHaveBeenCalled();

      // Permanent purge releases CAS blobId even when PageFile.hash is 40-char SHA-1
      jest
        .spyOn(repo, 'findByProjectAndId')
        .mockResolvedValueOnce(deletedEntity);
      jest.spyOn(repo, 'purge').mockResolvedValueOnce(true);
      jest.spyOn(repo, 'countReferencesByHash').mockResolvedValueOnce(0);

      await service.deleteFile(SPACE_ID, FILE_ID, true);
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_OLD_ID);
    });

    it('rejects DOC/FOLDER path collisions before quota reservation and releases superseded blobId on overwrite', async () => {
      const dataStream = Readable.from(Buffer.from('payload'));
      const destroySpy = jest.spyOn(dataStream, 'destroy');
      const reserveQuota = jest.fn();

      const collidingService = new FilestoreService(
        {
          resolvePageId: jest.fn(async () => PAGE_ID),
          hashStream: jest.fn(async () => ({
            contentHash: ContentHash.create(SHA1_HEX),
            sha256Hex: SHA256_NEW_HEX,
            sizeBytes: 7,
            dataStream,
          })),
          assertUploadPathAvailable: jest
            .fn()
            .mockRejectedValue(
              new DuplicateFileException('main.tex', SPACE_ID),
            ),
          findByProjectAndName: jest.fn(),
        } as unknown as FilestoreRepository,
        undefined,
        { reserveQuota, releaseQuota: jest.fn() } as unknown as IFilesPort,
      );

      await expect(
        collidingService.uploadFileFromStream(
          SPACE_ID,
          'main.tex',
          Readable.from(Buffer.from('payload')),
          'application/octet-stream',
          'manuscript-files',
          { pageId: PAGE_ID },
        ),
      ).rejects.toThrow(DuplicateFileException);
      expect(reserveQuota).not.toHaveBeenCalled();
      expect(destroySpy).toHaveBeenCalled();

      // Overwrite with new content releases previous blobId
      const existingFile = PageBinaryAsset.reconstitute({
        id: FILE_ID,
        projectId: SPACE_ID,
        pageId: PAGE_ID,
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
          resolvePageId: jest.fn(async () => PAGE_ID),
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
          save: jest.fn(async (f: PageBinaryAsset) => f),
        } as unknown as FilestoreRepository,
        undefined,
        {
          findBlobByHash: jest.fn().mockResolvedValue(null),
          registerUploadedObject: jest.fn().mockResolvedValue({
            blob: {
              id: BLOB_NEW_ID,
              s3Key: 'blobs/cas/new',
            },
          }),
          releaseBlob,
        } as unknown as IFilesPort,
      );

      const overwritten = await overwriteService.uploadFileFromStream(
        SPACE_ID,
        'fig.png',
        Readable.from(Buffer.from('new')),
        'image/png',
        'manuscript-files',
        { pageId: PAGE_ID },
      );
      expect(overwritten.blobId).toBe(BLOB_NEW_ID);
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_OLD_ID);
    });

    it('re-hydrates tombstoned CAS blob physical object when re-uploaded after deletion', async () => {
      const deletedBlob: StorageBlobRecord = {
        id: BLOB_OLD_ID,
        contentHashHex: PlatformContentHash.fromHex(SHA256_OLD_HEX).toHex(),
        hashAlgorithm: 'SHA256',
        sizeBytes: 12n,
        mimeType: 'application/octet-stream',
        checksumVerified: true,
        s3Key: PlatformStorageKey.fromString('blobs/canonical-sha256').value(),
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        status: BlobStatus.DELETED,
        refCount: 0,
        createdAt: new Date(),
        tombstoneAt: new Date(Date.now() + 3600_000),
        claimedAt: null,
      };

      const driver = {
        stat: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
        getStream: jest.fn().mockResolvedValue({
          stream: Readable.from(Buffer.from('hello-cas')),
          contentLength: 9,
        }),
        put: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
      };
      const blobRepo = {
        findByHash: jest.fn().mockResolvedValue(deletedBlob),
        incrementRefCount: jest.fn().mockResolvedValue(deletedBlob),
      } as unknown as jest.Mocked<BlobRepository>;

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
});
