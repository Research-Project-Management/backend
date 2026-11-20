import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'node:stream';
import { PrismaService } from '@/core';
import {
  PageBinaryAsset,
  ContentHash,
  StorageKey,
} from '@/modules/pages/filestore/filestore.types';
import { FilestoreRepository } from '@/modules/pages/filestore/filestore.repository';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { StructureRepository } from '@/modules/pages/structure/structure.repository';
import { PageService } from '@/modules/pages/core/services/page.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { PageScaffoldService } from '@/modules/pages/docstore/services/page-scaffold.service';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';
const DOC_MAIN_ID = '33333333-3333-4333-8333-333333333333';
const DOC_CHILD_ID = '44444444-4444-4444-8444-444444444444';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const BLOB_ID = '66666666-6666-4666-8666-666666666666';

describe('Virtual Tree Canonical BCNF/3NF Schema Contracts', () => {
  describe('1. StructureRepository 3NF Hydration & Page.rootDocId SSOT', () => {
    it('hydrates isRootDoc from Page.rootDocId and sizeBytes/hash from joined PageDoc/PageFile without persisting redundant columns on PageNode', async () => {
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
      const pageUpdateMany = jest.fn(
        async ({ data }: { data: { rootDocId: string | null } }) => {
          currentRootDocId = data.rootDocId;
          for (const row of nodeRows) {
            row.page.rootDocId = data.rootDocId as string;
          }
          return { count: 1 };
        },
      );

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
          updateMany: pageUpdateMany,
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
          create: jest.fn(
            async ({ data }: { data: Record<string, unknown> }) => ({
              id: 'node-created',
              ...data,
              createdAt: now,
              updatedAt: now,
              doc: { sizeBytes: 64, hash: 'sha256-created' },
              file: null,
              page: { rootDocId: currentRootDocId },
            }),
          ),
        },
      } as unknown as PrismaService;

      const repo = new StructureRepository(mockPrisma);

      const nodes = await repo.getAllNodes(SPACE_ID, PAGE_ID);
      const main = nodes.find((n) => n.id === 'node-main');
      const child = nodes.find((n) => n.id === 'node-child');
      const fig = nodes.find((n) => n.id === 'node-fig');

      expect(main?.isRootDoc).toBe(true);
      expect(main?.sizeBytes).toBe(512);
      expect(main?.hash).toBe('sha256-main');
      expect(child?.isRootDoc).toBe(false);
      expect(child?.sizeBytes).toBe(1024);
      expect(fig?.isRootDoc).toBe(false);
      expect(fig?.sizeBytes).toBe(8192);
      expect(fig?.hash).toBe('sha256-plot');

      // setRootDoc updates Page.rootDocId SSOT directly (not pageNode.updateMany)
      await repo.setRootDoc(SPACE_ID, 'node-child');
      expect(pageUpdateMany).toHaveBeenCalledWith({
        where: { id: PAGE_ID, spaceId: SPACE_ID },
        data: { rootDocId: DOC_CHILD_ID },
      });

      const fetchedRoot = await repo.getRootDoc(SPACE_ID, PAGE_ID);
      expect(fetchedRoot?.id).toBe('node-child');
      expect(fetchedRoot?.isRootDoc).toBe(true);

      await repo.unsetRootDoc(SPACE_ID, PAGE_ID);
      expect(currentRootDocId).toBeNull();
      expect(await repo.getRootDoc(SPACE_ID, PAGE_ID)).toBeNull();

      // createNode omits redundant columns on pageNode.create
      await repo.createNode({
        projectId: SPACE_ID,
        pageId: PAGE_ID,
        type: 'DOC',
        name: 'appendix.tex',
        path: '/appendix.tex',
        docId: '77777777-7777-4777-8777-777777777777',
      });
      const pageNodeCreateMock = mockPrisma.pageNode.create as jest.Mock<
        unknown,
        [{ data: Record<string, unknown> }]
      >;
      const createCall = pageNodeCreateMock.mock.calls[0][0];
      expect(createCall.data).not.toHaveProperty('isRootDoc');
      expect(createCall.data).not.toHaveProperty('sizeBytes');
      expect(createCall.data).not.toHaveProperty('hash');
      expect(createCall.data.pageId).toBe(PAGE_ID);
    });

    it('renameNode syncs lastKnownPath on PageDoc / PageFile inside transaction', async () => {
      const now = new Date('2026-06-01T00:00:00Z');
      const pageDocUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const pageNodeUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

      const mockPrisma = {
        $transaction: jest.fn(
          async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
            cb({
              pageNode: {
                updateMany: pageNodeUpdateMany,
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

      const repo = new StructureRepository(mockPrisma);
      const renamed = await repo.renameNode(
        SPACE_ID,
        'node-main',
        'paper.tex',
        '/paper.tex',
      );

      expect(renamed.path).toBe('/paper.tex');
      expect(renamed.isRootDoc).toBe(true);
      expect(pageDocUpdateMany).toHaveBeenCalledWith({
        where: { id: DOC_MAIN_ID, spaceId: SPACE_ID },
        data: { lastKnownPath: 'paper.tex' },
      });
    });
  });

  describe('2. Filestore lastKnownPath + StorageBlob CAS FK (blobId)', () => {
    it('persists lastKnownPath and blobId on PageFile upsert and releases blob via blobId on deleteFile', async () => {
      const shaHex = 'b'.repeat(64);
      const now = new Date('2026-06-01T00:00:00Z');
      const upsertMock = jest.fn(
        async ({ create }: { create: Record<string, unknown> }) => ({
          ...create,
          createdAt: now,
          updatedAt: now,
        }),
      );
      const findFirstMock = jest.fn().mockResolvedValue({
        id: FILE_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        blobId: BLOB_ID,
        lastKnownPath: 'figures/diagram.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        hash: shaHex,
        storageKey: 'blobs/bb/bb/rest',
        bucketName: 'manuscript-files',
        rev: 1,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const mockPrisma = {
        page: {
          findUnique: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            spaceId: SPACE_ID,
            deletedAt: null,
          }),
        },
        pageFile: {
          upsert: upsertMock,
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockImplementation(findFirstMock),
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

      const registerUploadedObject = jest.fn().mockResolvedValue({
        blob: {
          id: BLOB_ID,
          s3Key: 'blobs/cas/diagram',
        },
      });
      const releaseBlob = jest.fn().mockResolvedValue(undefined);

      const service = new FilestoreService(repo, undefined, {
        registerUploadedObject,
        releaseBlob,
        findBlobByHash: jest.fn(),
      } as never);

      jest.spyOn(repo, 'hashStream').mockResolvedValue({
        contentHash: ContentHash.create(shaHex),
        sha256Hex: shaHex,
        sizeBytes: 128,
        dataStream: Readable.from(Buffer.alloc(128, 1)),
      });
      jest
        .spyOn(repo, 'buildStorageKey')
        .mockReturnValue(StorageKey.fromRawKey('blobs/bb/bb/rest'));

      const saved = await service.uploadFileFromStream(
        SPACE_ID,
        'figures/diagram.png',
        Readable.from(Buffer.alloc(128, 1)),
        'image/png',
        'manuscript-files',
        { pageId: PAGE_ID },
      );

      expect(saved.blobId).toBe(BLOB_ID);
      expect(saved.name).toBe('figures/diagram.png');
      const upsertArg = upsertMock.mock.calls[0][0];
      expect(upsertArg.create.blobId).toBe(BLOB_ID);
      expect(upsertArg.create.lastKnownPath).toBe('figures/diagram.png');
      expect(upsertArg.create.pageId).toBe(PAGE_ID);

      // Node creation triggered by syncFileNode must not include redundant sizeBytes/hash/isRootDoc
      const syncNodeCreateMock = mockPrisma.pageNode.create as jest.Mock<
        unknown,
        [{ data: Record<string, unknown> }]
      >;
      const nodeCreateCall = syncNodeCreateMock.mock.calls.find(
        (c) => c[0].data.type === 'FILE',
      )?.[0];
      expect(nodeCreateCall).toBeDefined();
      expect(nodeCreateCall?.data.pageId).toBe(PAGE_ID);
      expect(nodeCreateCall?.data).not.toHaveProperty('sizeBytes');
      expect(nodeCreateCall?.data).not.toHaveProperty('hash');
      expect(nodeCreateCall?.data).not.toHaveProperty('isRootDoc');

      // Delete prefers direct releaseBlob(file.blobId)
      const entityForDelete = PageBinaryAsset.reconstitute({
        id: FILE_ID,
        projectId: SPACE_ID,
        pageId: PAGE_ID,
        blobId: BLOB_ID,
        name: 'figures/diagram.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        hash: ContentHash.create(shaHex),
        storageKey: StorageKey.fromRawKey('blobs/cas/diagram'),
      });
      jest
        .spyOn(repo, 'findByProjectAndId')
        .mockResolvedValueOnce(entityForDelete);

      await service.deleteFile(SPACE_ID, FILE_ID);
      expect(releaseBlob).toHaveBeenCalledWith(BLOB_ID);
    });
  });

  describe('3. PostgreSQL SQL Backfill & Integrity Constraints Contract', () => {
    it('defines all BCNF/3NF composite FKs, POSIX path/depth checks, sibling unique index, and parent guard trigger', () => {
      const repoRoot = path.resolve(__dirname, '../../../');
      const backfillSql = fs.readFileSync(
        path.join(repoRoot, 'prisma/sql/pages-vtree-backfill.sql'),
        'utf8',
      );
      const integritySql = fs.readFileSync(
        path.join(repoRoot, 'prisma/sql/pages-schema-integrity.sql'),
        'utf8',
      );

      expect(backfillSql).toContain(
        'RENAME COLUMN "path" TO "last_known_path"',
      );
      expect(backfillSql).toContain(
        'RENAME COLUMN "name" TO "last_known_path"',
      );
      expect(backfillSql).toContain('UPDATE "pages" p');
      expect(backfillSql).toContain('UPDATE "page_files" f');

      for (const symbol of [
        'fk_page_nodes_parent_same_page',
        'fk_page_nodes_doc_same_page',
        'fk_page_nodes_file_same_page',
        'fk_pages_root_doc_same_page',
        'chk_page_nodes_exclusive_arc',
        'chk_page_nodes_no_self_parent',
        'chk_page_nodes_path_depth_invariants',
        'uq_page_nodes_sibling_name',
        'idx_page_nodes_page_path_pattern',
        'trg_page_nodes_parent_guard',
        'trg_pages_root_doc_same_page',
        'clone_page_virtual_tree',
      ]) {
        expect(integritySql).toContain(symbol);
      }
    });
  });

  describe('4. Canonical Page Duplication (Full Virtual Tree + Stored Procedure)', () => {
    it('creates a brand-new Page Aggregate Root and clones full Virtual Tree (docs, files, folders, StorageBlob refCount) without mutating source page', async () => {
      const now = new Date('2026-06-01T00:00:00Z');
      const DOC_INTRO_ID = '44444444-4444-4444-8444-444444444445';
      const NODE_ROOT_ID = '77777777-7777-4777-8777-777777777701';
      const NODE_CHAPTERS_ID = '77777777-7777-4777-8777-777777777702';
      const NODE_INTRO_ID = '77777777-7777-4777-8777-777777777703';
      const NODE_FIGURES_ID = '77777777-7777-4777-8777-777777777704';
      const NODE_IMG_ID = '77777777-7777-4777-8777-777777777705';

      const sourcePage = {
        id: PAGE_ID,
        spaceId: SPACE_ID,
        rootDocId: DOC_MAIN_ID,
        title: 'Deep Learning Paper',
        description: 'Camera-ready manuscript',
        compiler: 'pdflatex',
        texLiveVersion: '2024',
        spellCheckLanguage: 'en_US',
        settings: { autoCompile: true },
        createdById: null,
        deletedAt: null,
      };

      const sourceDocs = [
        {
          id: DOC_MAIN_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          lastKnownPath: 'main.tex',
          lines: ['\\documentclass{article}', '\\input{chapters/intro}'],
          rev: 4,
          version: 4,
          ranges: { title: 'Deep Learning Paper' },
          hash: 'h-main',
          sizeBytes: 64,
          inStorage: false,
          storageKey: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: DOC_INTRO_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          lastKnownPath: 'chapters/intro.tex',
          lines: ['\\section{Introduction}', 'Canonical tree test.'],
          rev: 2,
          version: 2,
          ranges: {},
          hash: 'h-intro',
          sizeBytes: 42,
          inStorage: false,
          storageKey: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ];

      const sourceFiles = [
        {
          id: FILE_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          blobId: BLOB_ID,
          lastKnownPath: 'figures/arch.png',
          mimeType: 'image/png',
          sizeBytes: 4096,
          hash: 'a'.repeat(64),
          storageKey: 'blobs/aa/aa/arch',
          bucketName: 'manuscript-files',
          rev: 1,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ];

      const sourceNodes = [
        {
          id: NODE_ROOT_ID,
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
        },
        {
          id: NODE_CHAPTERS_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: null,
          type: 'FOLDER' as const,
          name: 'chapters',
          path: '/chapters',
          depth: 1,
          docId: null,
          fileId: null,
          sortOrder: 1,
        },
        {
          id: NODE_FIGURES_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: null,
          type: 'FOLDER' as const,
          name: 'figures',
          path: '/figures',
          depth: 1,
          docId: null,
          fileId: null,
          sortOrder: 2,
        },
        {
          id: NODE_INTRO_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: NODE_CHAPTERS_ID,
          type: 'DOC' as const,
          name: 'intro.tex',
          path: '/chapters/intro.tex',
          depth: 2,
          docId: DOC_INTRO_ID,
          fileId: null,
          sortOrder: 0,
        },
        {
          id: NODE_IMG_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: NODE_FIGURES_ID,
          type: 'FILE' as const,
          name: 'arch.png',
          path: '/figures/arch.png',
          depth: 2,
          docId: null,
          fileId: FILE_ID,
          sortOrder: 0,
        },
      ];

      const createdPages: Array<Record<string, unknown>> = [];
      const createdDocs: Array<Record<string, unknown>> = [];
      const createdFiles: Array<Record<string, unknown>> = [];
      const createdNodes: Array<Record<string, unknown>> = [];
      const updatedPages: Array<Record<string, unknown>> = [];
      const acquireBlob = jest.fn().mockResolvedValue({});

      const mockPrisma = {
        page: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
            where.id === PAGE_ID ? sourcePage : null,
          ),
          findMany: jest.fn(async () => [{ title: 'Deep Learning Paper' }]),
        },
        pageDoc: {
          findUnique: jest.fn(
            async ({ where }: { where: { id: string } }) =>
              sourceDocs.find((d) => d.id === where.id) ?? null,
          ),
          findFirst: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) =>
              sourceDocs.find((d) => d.id === where.id) ?? sourceDocs[0],
          ),
          findMany: jest.fn(async () => sourceDocs),
        },
        pageFile: {
          findMany: jest.fn(async () => sourceFiles),
        },
        pageNode: {
          findMany: jest.fn(async () => sourceNodes),
        },
        $transaction: jest.fn(
          async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
            cb({
              page: {
                create: jest.fn(
                  async ({ data }: { data: Record<string, unknown> }) => {
                    createdPages.push(data);
                    return data;
                  },
                ),
                updateMany: jest.fn(async (args: Record<string, unknown>) => {
                  updatedPages.push(args);
                  return { count: 1 };
                }),
              },
              pageDoc: {
                create: jest.fn(
                  async ({ data }: { data: Record<string, unknown> }) => {
                    createdDocs.push(data);
                    return data;
                  },
                ),
              },
              pageFile: {
                create: jest.fn(
                  async ({ data }: { data: Record<string, unknown> }) => {
                    createdFiles.push(data);
                    return data;
                  },
                ),
              },
              pageNode: {
                create: jest.fn(
                  async ({ data }: { data: Record<string, unknown> }) => {
                    createdNodes.push(data);
                    return data;
                  },
                ),
              },
            }),
        ),
      } as unknown as PrismaService;

      const flushDocs = jest.fn().mockResolvedValue([]);
      const pageService = new PageService(
        mockPrisma,
        {} as DocstoreService,
        {} as PageScaffoldService,
        undefined,
        {
          applyExternalText: jest.fn(),
          flushDocs,
        },
        undefined,
        undefined,
        { acquireBlob } as any,
      );

      const res = await pageService.duplicatePage(PAGE_ID, SPACE_ID);

      expect(flushDocs).toHaveBeenCalledWith(
        SPACE_ID,
        expect.arrayContaining([DOC_MAIN_ID, DOC_INTRO_ID]),
      );

      expect(res.page.id).not.toBe(PAGE_ID);
      expect(res.page.title).toBe('Deep Learning Paper (Copy)');
      expect(res.rootPageId).toBe(res.page.id);

      // New Page Aggregate Root created & wired to new root doc
      expect(createdPages).toHaveLength(1);
      expect(createdPages[0].id).toBe(res.page.id);
      expect(createdPages[0].title).toBe('Deep Learning Paper (Copy)');
      expect(createdPages[0].rootDocId).toBeNull();
      expect(updatedPages).toHaveLength(1);
      expect(updatedPages[0].data).toEqual({ rootDocId: res.page.id });

      // All PageDocs cloned into newPageId with original POSIX paths
      expect(createdDocs).toHaveLength(2);
      expect(createdDocs.every((d) => d.pageId === res.page.id)).toBe(true);
      expect(createdDocs.map((d) => d.lastKnownPath)).toEqual([
        'main.tex',
        'chapters/intro.tex',
      ]);

      // All PageFiles cloned into newPageId and StorageBlob refCount incremented via FILES_PORT
      expect(createdFiles).toHaveLength(1);
      expect(createdFiles[0].pageId).toBe(res.page.id);
      expect(createdFiles[0].blobId).toBe(BLOB_ID);
      expect(acquireBlob).toHaveBeenCalledWith(BLOB_ID);

      // Full Virtual Tree hierarchy cloned with mapped parentIds under newPageId
      expect(createdNodes).toHaveLength(5);
      expect(createdNodes.every((n) => n.pageId === res.page.id)).toBe(true);
      const clonedChaptersNode = createdNodes.find(
        (n) => n.path === '/chapters',
      );
      const clonedIntroNode = createdNodes.find(
        (n) => n.path === '/chapters/intro.tex',
      );
      expect(clonedChaptersNode).toBeDefined();
      expect(clonedIntroNode).toBeDefined();
      expect(clonedIntroNode?.parentId).toBe(clonedChaptersNode?.id);
      expect(clonedIntroNode?.parentId).not.toBe(NODE_CHAPTERS_ID);
    });

    it('invokes PostgreSQL clone_page_virtual_tree Stored Procedure in one atomic CALL when available', async () => {
      const sourcePage = {
        id: PAGE_ID,
        spaceId: SPACE_ID,
        rootDocId: DOC_MAIN_ID,
        title: 'Large Monograph',
        deletedAt: null,
      };
      const sourceDoc = {
        id: DOC_MAIN_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_ID,
        lastKnownPath: 'main.tex',
        lines: ['\\documentclass{book}'],
        inStorage: false,
        ranges: { title: 'Large Monograph' },
        deletedAt: null,
      };

      const executeRawMock = jest.fn().mockResolvedValue(undefined);
      const queryRawMock = jest.fn().mockResolvedValue([{ exists: true }]);
      const pageCreateMock = jest.fn();

      const mockPrisma = {
        page: {
          findUnique: jest.fn().mockResolvedValue(sourcePage),
          findMany: jest
            .fn()
            .mockResolvedValue([
              { title: 'Large Monograph' },
              { title: 'Large Monograph (Copy)' },
            ]),
        },
        pageDoc: {
          findUnique: jest.fn().mockResolvedValue(sourceDoc),
          findFirst: jest.fn().mockResolvedValue(sourceDoc),
          findMany: jest.fn().mockResolvedValue([sourceDoc]),
        },
        pageFile: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        pageNode: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        $transaction: jest.fn(
          async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
            cb({
              $queryRaw: queryRawMock,
              $executeRaw: executeRawMock,
              page: { create: pageCreateMock },
            }),
        ),
      } as unknown as PrismaService;

      const pageService = new PageService(
        mockPrisma,
        {} as DocstoreService,
        {} as PageScaffoldService,
      );

      const res = await pageService.duplicatePage(PAGE_ID, SPACE_ID);

      expect(res.page.title).toBe('Large Monograph (Copy 2)');
      expect(queryRawMock).toHaveBeenCalledTimes(1);
      expect(executeRawMock).toHaveBeenCalledTimes(1);
      const executeCalls = (
        executeRawMock as jest.Mock<
          unknown,
          [TemplateStringsArray, ...unknown[]]
        >
      ).mock.calls[0];
      expect(executeCalls[0].join('?')).toContain(
        'CALL clone_page_virtual_tree',
      );
      expect(pageCreateMock).not.toHaveBeenCalled();
    });
  });
});
