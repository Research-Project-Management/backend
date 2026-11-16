import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'node:stream';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core';
import { Role } from '@/modules/project/access';
import { EditorBootstrapService } from '@/modules/pages/bootstrap';
import { ClsiService } from '@/modules/pages/clsi/services/clsi.service';
import { LatexmkEngine } from '@/modules/pages/clsi/services/compile-pipeline.service';
import { RemoteClsiClientAdapter } from '@/modules/pages/clsi/services/remote-clsi.client';
import { WorkspacePlannerService } from '@/modules/pages/clsi/services/workspace-planner.service';
import { WorkspaceRepository } from '@/modules/pages/clsi/repositories/workspace.repository';
import { SafePath } from '@/modules/pages/clsi/domain/safe-path';
import { UnsafePathException } from '@/modules/pages/clsi/domain/sandbox.errors';
import { planDbFileSet } from '@/modules/pages/clsi/domain/fileset.planner';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { PageService } from '@/modules/pages/core/services/page.service';
import {
  FilestoreValidationException,
  ManuscriptFile,
} from '@/modules/pages/filestore/filestore.types';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import {
  ManuscriptNodeEntity,
  IStructureRepository,
} from '@/modules/pages/structure/domain';
import {
  StructureRepository,
  ensurePrismaFolderChain,
} from '@/modules/pages/structure/structure.repository';
import { StructureService } from '@/modules/pages/structure/structure.service';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE_A_ID = '66666666-6666-4666-8666-666666666661';
const PAGE_B_ID = '66666666-6666-4666-8666-666666666662';
const DOC_A_MAIN_ID = '22222222-2222-4222-8222-222222222221';
const DOC_B_MAIN_ID = '22222222-2222-4222-8222-222222222222';
const DELETED_PAGE_ID = '77777777-7777-4777-8777-777777777777';

function makeNode(
  overrides: Partial<{
    id: string;
    projectId: string;
    pageId: string | null;
    parentId: string | null;
    type: 'FOLDER' | 'DOC' | 'FILE';
    name: string;
    path: string;
    docId: string | null;
    fileId: string | null;
    isRootDoc: boolean;
  }>,
): ManuscriptNodeEntity {
  return new ManuscriptNodeEntity({
    id: overrides.id ?? 'node-1',
    projectId: overrides.projectId ?? SPACE_ID,
    pageId: overrides.pageId ?? null,
    parentId: overrides.parentId ?? null,
    type: overrides.type ?? 'DOC',
    name: overrides.name ?? 'main.tex',
    path: overrides.path ?? '/main.tex',
    docId: overrides.docId ?? null,
    fileId: overrides.fileId ?? null,
    isRootDoc: overrides.isRootDoc ?? false,
    sizeBytes: 120,
  });
}

describe('Virtual Tree Multi-Page Isolation & CLSI Hardening', () => {
  describe('1. StructureService & StructureRepository (spaceId, pageId) isolation', () => {
    it('passes pageId scope on deleteNode, renameNode, and moveNode across sibling manuscripts', async () => {
      const folderA = makeNode({
        id: 'folder-a',
        pageId: PAGE_A_ID,
        type: 'FOLDER',
        name: 'chapters',
        path: '/chapters',
      });
      const rootDocA = makeNode({
        id: 'root-a',
        pageId: PAGE_A_ID,
        type: 'DOC',
        name: 'main.tex',
        path: '/main.tex',
        docId: DOC_A_MAIN_ID,
        isRootDoc: true,
      });
      const childDocA = makeNode({
        id: 'child-a',
        pageId: PAGE_A_ID,
        parentId: 'folder-a',
        type: 'DOC',
        name: 'intro.tex',
        path: '/chapters/intro.tex',
        docId: '33333333-3333-4333-8333-333333333331',
      });

      const mockRepo: jest.Mocked<IStructureRepository> = {
        createNode: jest.fn(),
        findById: jest.fn(async (_proj, id) => {
          if (id === 'folder-a') return folderA;
          if (id === 'root-a') return rootDocA;
          if (id === 'child-a') return childDocA;
          return null;
        }),
        findByPath: jest.fn().mockResolvedValue(null),
        findByFileId: jest.fn().mockResolvedValue(null),
        getAllNodes: jest.fn().mockResolvedValue([rootDocA]),
        getRootDoc: jest.fn().mockResolvedValue(null),
        setRootDoc: jest.fn().mockResolvedValue(undefined),
        unsetRootDoc: jest.fn().mockResolvedValue(undefined),
        moveSubtree: jest.fn().mockResolvedValue(undefined),
        renameNode: jest.fn().mockResolvedValue(childDocA),
        deleteSubtree: jest.fn().mockResolvedValue([folderA, childDocA]),
        updateSortOrder: jest.fn().mockResolvedValue(undefined),
        countNodes: jest.fn().mockResolvedValue(3),
      };

      const mockDocstore = {
        getAllDocs: jest.fn().mockResolvedValue([]),
      } as unknown as DocstoreService;

      const service = new StructureService(
        mockRepo,
        undefined,
        undefined,
        mockDocstore,
      );

      // moveNode must scope parent lookup, conflict check, and moveSubtree to PAGE_A_ID
      await service.moveNode(SPACE_ID, 'child-a', {
        destPath: '/sections/intro.tex',
      });
      expect(mockRepo.findByPath).toHaveBeenCalledWith(
        SPACE_ID,
        '/sections',
        PAGE_A_ID,
      );
      expect(mockRepo.findByPath).toHaveBeenCalledWith(
        SPACE_ID,
        '/sections/intro.tex',
        PAGE_A_ID,
      );
      expect(mockRepo.moveSubtree).toHaveBeenCalledWith(
        SPACE_ID,
        '/chapters/intro.tex',
        '/sections/intro.tex',
        null,
        { nodeId: 'child-a', pageId: PAGE_A_ID },
      );

      // renameNode on folder must scope conflict check and moveSubtree to PAGE_A_ID
      await service.renameNode(SPACE_ID, 'folder-a', { name: 'parts' });
      expect(mockRepo.findByPath).toHaveBeenCalledWith(
        SPACE_ID,
        '/parts',
        PAGE_A_ID,
      );
      expect(mockRepo.moveSubtree).toHaveBeenCalledWith(
        SPACE_ID,
        '/chapters',
        '/parts',
        null,
        { nodeId: 'folder-a', pageId: PAGE_A_ID },
      );

      // deleteNode on root doc must scope deleteSubtree, unsetRootDoc, getAllDocs, and autoDetectRootDoc to PAGE_A_ID
      mockRepo.deleteSubtree.mockResolvedValueOnce([rootDocA]);
      await service.deleteNode(SPACE_ID, 'root-a');
      expect(mockRepo.deleteSubtree).toHaveBeenCalledWith(
        SPACE_ID,
        '/main.tex',
        PAGE_A_ID,
      );
      expect(mockRepo.unsetRootDoc).toHaveBeenCalledWith(SPACE_ID, PAGE_A_ID);
      expect(mockDocstore.getAllDocs).toHaveBeenCalledWith(SPACE_ID, PAGE_A_ID);
      expect(mockRepo.getRootDoc).toHaveBeenCalledWith(SPACE_ID, PAGE_A_ID);
    });

    it('StructureRepository.deleteSubtree and moveSubtree isolate sibling pages with identical paths', async () => {
      interface StoredRow {
        id: string;
        spaceId: string;
        pageId: string | null;
        parentId: string | null;
        type: 'FOLDER' | 'DOC' | 'FILE';
        name: string;
        path: string;
        depth: number;
        docId: string | null;
        fileId: string | null;
        isRootDoc: boolean;
        sizeBytes: number;
        hash: string | null;
        sortOrder: number;
        createdAt: Date;
        updatedAt: Date;
      }

      const now = new Date();
      const rows: StoredRow[] = [
        {
          id: 'folder-a',
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
          parentId: null,
          type: 'FOLDER',
          name: 'chapters',
          path: '/chapters',
          depth: 1,
          docId: null,
          fileId: null,
          isRootDoc: false,
          sizeBytes: 0,
          hash: null,
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'doc-a',
          spaceId: SPACE_ID,
          pageId: PAGE_A_ID,
          parentId: 'folder-a',
          type: 'DOC',
          name: 'intro.tex',
          path: '/chapters/intro.tex',
          depth: 2,
          docId: 'doc-id-a',
          fileId: null,
          isRootDoc: false,
          sizeBytes: 10,
          hash: null,
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'folder-b',
          spaceId: SPACE_ID,
          pageId: PAGE_B_ID,
          parentId: null,
          type: 'FOLDER',
          name: 'chapters',
          path: '/chapters',
          depth: 1,
          docId: null,
          fileId: null,
          isRootDoc: false,
          sizeBytes: 0,
          hash: null,
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'doc-b',
          spaceId: SPACE_ID,
          pageId: PAGE_B_ID,
          parentId: 'folder-b',
          type: 'DOC',
          name: 'intro.tex',
          path: '/chapters/intro.tex',
          depth: 2,
          docId: 'doc-id-b',
          fileId: null,
          isRootDoc: false,
          sizeBytes: 10,
          hash: null,
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];

      const matchesWhere = (
        row: StoredRow,
        where: Record<string, unknown> = {},
      ): boolean => {
        if (where.id !== undefined) {
          if (typeof where.id === 'string' && row.id !== where.id) return false;
          if (
            typeof where.id === 'object' &&
            where.id !== null &&
            'in' in where.id &&
            !(where.id as { in: string[] }).in.includes(row.id)
          ) {
            return false;
          }
        }
        if (where.spaceId !== undefined && row.spaceId !== where.spaceId) {
          return false;
        }
        if ('pageId' in where && row.pageId !== where.pageId) {
          return false;
        }
        if (where.path !== undefined) {
          if (typeof where.path === 'string' && row.path !== where.path) {
            return false;
          }
          if (
            typeof where.path === 'object' &&
            where.path !== null &&
            'startsWith' in where.path &&
            !row.path.startsWith((where.path as { startsWith: string }).startsWith)
          ) {
            return false;
          }
        }
        if (Array.isArray(where.OR)) {
          return where.OR.some((clause) =>
            matchesWhere(row, clause as Record<string, unknown>),
          );
        }
        return true;
      };

      const txMock = {
        pageNode: {
          findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
            rows.find((r) => matchesWhere(r, where)) ?? null,
          ),
          findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
            rows.filter((r) => matchesWhere(r, where)),
          ),
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Partial<StoredRow>;
            }) => {
              const target = rows.find((r) => r.id === where.id)!;
              Object.assign(target, data);
              return target;
            },
          ),
          deleteMany: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) => {
              const before = rows.length;
              for (let i = rows.length - 1; i >= 0; i--) {
                if (matchesWhere(rows[i], where)) {
                  rows.splice(i, 1);
                }
              }
              return { count: before - rows.length };
            },
          ),
        },
        pageDoc: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        pageFile: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const mockPrisma = {
        ...txMock,
        $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) =>
          cb(txMock),
        ),
      } as unknown as PrismaService;

      const repo = new StructureRepository(mockPrisma);

      // Moving Page A's /chapters -> /sections must leave Page B's /chapters untouched
      await repo.moveSubtree(SPACE_ID, '/chapters', '/sections', null, {
        nodeId: 'folder-a',
        pageId: PAGE_A_ID,
      });

      expect(rows.find((r) => r.id === 'folder-a')?.path).toBe('/sections');
      expect(rows.find((r) => r.id === 'doc-a')?.path).toBe(
        '/sections/intro.tex',
      );
      expect(rows.find((r) => r.id === 'folder-b')?.path).toBe('/chapters');
      expect(rows.find((r) => r.id === 'doc-b')?.path).toBe(
        '/chapters/intro.tex',
      );

      // Deleting Page A's /sections must leave Page B's nodes untouched
      const deleted = await repo.deleteSubtree(
        SPACE_ID,
        '/sections',
        PAGE_A_ID,
      );
      expect(deleted.map((n) => n.id)).toEqual(['folder-a', 'doc-a']);
      expect(rows.map((r) => r.id)).toEqual(['folder-b', 'doc-b']);

      // ensurePrismaFolderChain with !pageId must scope findMany & findFirst with pageId: null
      const findManyMock = jest.fn().mockResolvedValue([]);
      const findFirstMock = jest.fn().mockResolvedValue(null);
      const createMock = jest.fn(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: `created-${String(data.name)}`,
          ...data,
        }),
      );
      await ensurePrismaFolderChain(
        {
          pageNode: {
            findMany: findManyMock,
            findFirst: findFirstMock,
            create: createMock,
          },
        } as never,
        SPACE_ID,
        [
          { name: 'a', path: '/a', depth: 1 },
          { name: 'b', path: '/a/b', depth: 2 },
        ],
        null,
      );
      expect(findManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            spaceId: SPACE_ID,
            pageId: null,
          }),
        }),
      );
      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            spaceId: SPACE_ID,
            pageId: null,
          }),
        }),
      );
    });
  });

  describe('2. RemoteClsiClientAdapter binary base64: prefixing', () => {
    it('encodes Buffer files with base64: prefix while preserving string files', async () => {
      const adapter = new RemoteClsiClientAdapter({
        get: jest.fn(() => 'http://127.0.0.1:3013'),
      } as unknown as ConfigService);

      const originalFetch = global.fetch;
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          logs: '',
          durationMs: 12,
        }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      try {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        await adapter.tryRemoteClsiCompile({
          projectId: PAGE_A_ID,
          mainFile: 'main.tex',
          source: '\\documentclass{article}',
          mergedFiles: {
            'main.tex': '\\documentclass{article}',
            'figures/logo.png': pngBytes,
          },
          dto: {} as never,
          cacheKey: 'cache-1',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [
          string,
          { body: string },
        ];
        const payload = JSON.parse(init.body) as {
          files: Record<string, string>;
        };
        expect(payload.files['main.tex']).toBe('\\documentclass{article}');
        expect(payload.files['figures/logo.png']).toBe(
          `base64:${pngBytes.toString('base64')}`,
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('3. SafePath hardening', () => {
    it('rejects ".", root equivalence, traversal escapes, and dangling symlinks', async () => {
      const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'safepath-'));
      try {
        expect(() => SafePath.sanitizeRelativePath('.')).toThrow(
          UnsafePathException,
        );
        expect(() => SafePath.sanitizeRelativePath('./')).toThrow(
          UnsafePathException,
        );
        expect(() => SafePath.sanitizeRelativePath('a/..')).toThrow(
          UnsafePathException,
        );

        expect(() => SafePath.resolveSafePath(tmpBase, '.')).toThrow(
          UnsafePathException,
        );
        expect(() =>
          SafePath.resolveSafePath(tmpBase, '../outside.tex'),
        ).toThrow(UnsafePathException);
        expect(() =>
          SafePath.resolveSafePath(
            tmpBase,
            `../${path.basename(tmpBase)}-evil/secret.tex`,
          ),
        ).toThrow(UnsafePathException);

        const danglingLinkPath = path.join(tmpBase, 'dangling.tex');
        let createdRealSymlink = false;
        try {
          await fs.symlink(
            path.join(tmpBase, 'does-not-exist.tex'),
            danglingLinkPath,
          );
          createdRealSymlink = true;
        } catch {
          createdRealSymlink = false;
        }

        if (createdRealSymlink) {
          await expect(
            SafePath.assertSafeWorkspacePath(tmpBase, 'dangling.tex'),
          ).rejects.toThrow(UnsafePathException);
        } else {
          // Fallback on Windows environments without symlink creation privileges
          const realpathSpy = jest
            .spyOn(fs, 'realpath')
            .mockImplementation(async (target) => {
              if (String(target) === tmpBase) return tmpBase;
              throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            });
          const lstatSpy = jest
            .spyOn(fs, 'lstat')
            .mockResolvedValue({
              isSymbolicLink: () => true,
            } as unknown as Awaited<ReturnType<typeof fs.lstat>>);
          try {
            await expect(
              SafePath.assertSafeWorkspacePath(tmpBase, 'dangling.tex'),
            ).rejects.toThrow(UnsafePathException);
          } finally {
            realpathSpy.mockRestore();
            lstatSpy.mockRestore();
          }
        }
      } finally {
        await fs.rm(tmpBase, { recursive: true, force: true });
      }
    });
  });

  describe('4. EditorBootstrapService deleted pageId & strict isolation', () => {
    it('throws NotFoundException (404) for deleted :pageId instead of falling back to another manuscript', async () => {
      const activeSiblingDoc = {
        id: DOC_A_MAIN_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_A_ID,
        path: '/main.tex',
        lines: ['\\documentclass{article}'],
        inStorage: false,
        version: 1,
        rev: 1,
        ranges: {},
        hash: 'h1',
        sizeBytes: 22,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        node: {
          id: 'node-a',
          name: 'main.tex',
          path: '/main.tex',
        },
      };

      const mockPrisma = {
        project: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: SPACE_ID, name: 'Test Space' }),
        },
        page: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
            if (where.id === DELETED_PAGE_ID) {
              return {
                id: DELETED_PAGE_ID,
                spaceId: SPACE_ID,
                rootDocId: DOC_B_MAIN_ID,
                title: 'Deleted Paper',
                deletedAt: new Date('2026-01-01T00:00:00Z'),
              };
            }
            return null;
          }),
        },
        pageNode: {
          // Simulates findPageRecordWithNode's space-level root fallback returning sibling Page A
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'node-a', docId: DOC_A_MAIN_ID }),
        },
        pageDoc: {
          findFirst: jest.fn(
            async ({ where }: { where: Record<string, unknown> }) => {
              if (where.id === DOC_A_MAIN_ID) return activeSiblingDoc;
              return null;
            },
          ),
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as unknown as PrismaService;

      const mockPageService = {
        resolveActiveProjectId: jest.fn((p: unknown) =>
          typeof p === 'string' ? p : (p as { id?: string })?.id,
        ),
        resolveProjectId: jest.fn().mockResolvedValue(SPACE_ID),
        getLiveCollaboration: jest.fn().mockReturnValue(null),
      } as unknown as PageService;

      const bootstrap = new EditorBootstrapService(
        mockPrisma,
        mockPageService,
        {} as DocstoreService,
        {
          getAllNodes: jest.fn().mockResolvedValue([]),
          getProjectSymbols: jest.fn(),
        } as unknown as StructureService,
        { getLastBuildSummary: jest.fn() } as unknown as ClsiService,
      );

      await expect(
        bootstrap.bootstrapEditor({
          pageOrProjectId: DELETED_PAGE_ID,
          userId: USER_ID,
          authorizedProjectId: SPACE_ID,
          role: Role.OWNER,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects unscoped pageId=null active candidate when bootstrapping a scoped Page', async () => {
      const unscopedLegacyDocId = '88888888-8888-4888-8888-888888888888';
      const page2RootDoc = {
        id: DOC_B_MAIN_ID,
        spaceId: SPACE_ID,
        pageId: PAGE_B_ID,
        path: '/main.tex',
        lines: ['\\documentclass{article}', 'Page B'],
        inStorage: false,
        version: 1,
        rev: 1,
        ranges: { title: 'Paper B' },
        hash: 'hb',
        sizeBytes: 30,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        node: {
          id: 'node-b-main',
          name: 'main.tex',
          path: '/main.tex',
        },
      };
      const unscopedDoc = {
        id: unscopedLegacyDocId,
        spaceId: SPACE_ID,
        pageId: null,
        path: '/legacy.tex',
        lines: ['Legacy secret'],
        inStorage: false,
        version: 1,
        rev: 1,
        ranges: {},
        hash: 'hl',
        sizeBytes: 13,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        node: {
          id: 'node-legacy',
          name: 'legacy.tex',
          path: '/legacy.tex',
        },
      };

      const mockPrisma = {
        project: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: SPACE_ID, name: 'Test Space' }),
        },
        page: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
            where.id === PAGE_B_ID
              ? {
                  id: PAGE_B_ID,
                  spaceId: SPACE_ID,
                  rootDocId: DOC_B_MAIN_ID,
                  title: 'Paper B',
                  deletedAt: null,
                }
              : null,
          ),
        },
        pageNode: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        pageDoc: {
          findFirst: jest.fn(
            async ({ where }: { where: { OR?: Array<Record<string, unknown>>; id?: string } }) => {
              if (where.id === DOC_B_MAIN_ID) return page2RootDoc;
              if (
                where.OR?.some(
                  (c) =>
                    c.id === unscopedLegacyDocId ||
                    (c.node as { id?: string } | undefined)?.id ===
                      unscopedLegacyDocId,
                )
              ) {
                return unscopedDoc;
              }
              return null;
            },
          ),
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as unknown as PrismaService;

      const pageBNode = makeNode({
        id: 'node-b-main',
        pageId: PAGE_B_ID,
        type: 'DOC',
        name: 'main.tex',
        path: '/main.tex',
        docId: DOC_B_MAIN_ID,
        isRootDoc: true,
      });

      const bootstrap = new EditorBootstrapService(
        mockPrisma,
        {
          resolveActiveProjectId: (p: unknown) =>
            typeof p === 'string' ? p : (p as { id?: string })?.id,
          resolveProjectId: jest.fn().mockResolvedValue(SPACE_ID),
          getLiveCollaboration: jest.fn().mockReturnValue(null),
        } as unknown as PageService,
        {
          getDoc: jest.fn(),
        } as unknown as DocstoreService,
        {
          getAllNodes: jest.fn().mockResolvedValue([pageBNode]),
          getProjectSymbols: jest.fn().mockResolvedValue(null),
        } as unknown as StructureService,
        {
          getLastBuildSummary: jest.fn().mockResolvedValue({
            status: 'uncompiled',
            pdfArtifactUrl: null,
            synctexAvailable: false,
            lastCompiledAt: null,
            diagnostics: [],
          }),
        } as unknown as ClsiService,
      );

      const res = await bootstrap.bootstrapEditor({
        pageOrProjectId: PAGE_B_ID,
        requestedFileId: unscopedLegacyDocId,
        userId: USER_ID,
        authorizedProjectId: SPACE_ID,
      });

      expect(res.activeDoc.id).toBe(DOC_B_MAIN_ID);
      expect(res.activeDoc.fallbackToRoot).toBe(true);
    });
  });

  describe('5. Filestore, LatexmkEngine nested promotion, and WorkspacePlanner cache', () => {
    it('ManuscriptFile.sanitizeFilename rejects null bytes and caps flattened filenames to 255 chars', () => {
      expect(() =>
        ManuscriptFile.sanitizeFilename('bad\u0000name.png'),
      ).toThrow(FilestoreValidationException);

      const longTraversal = `../${'a'.repeat(300)}.png`;
      const sanitized = ManuscriptFile.sanitizeFilename(longTraversal);
      expect(sanitized.length).toBeLessThanOrEqual(255);
    });

    it('FilestoreService.uploadFileFromStream isolates lookup and storage by pageId', async () => {
      const mockRepo = {
        resolvePageId: jest.fn(async (_p: string, id: string) => id),
        hashStream: jest.fn(async () => ({
          contentHash: { getValue: () => 'a'.repeat(64) },
          sha256Hex: 'a'.repeat(64),
          sizeBytes: 4,
          dataStream: Readable.from(Buffer.from('test')),
        })),
        findByProjectAndName: jest.fn().mockResolvedValue(null),
        buildStorageKey: jest.fn(() => ({ getValue: () => 'blobs/aa/aa/rest' })),
        checkObjectExists: jest.fn().mockResolvedValue(true),
        save: jest.fn(async (file: ManuscriptFile) => file),
      };
      const service = new FilestoreService(mockRepo as never);
      const saved = await service.uploadFileFromStream(
        SPACE_ID,
        'fig.png',
        Readable.from(Buffer.from('test')),
        'image/png',
        'manuscript-files',
        { pageId: PAGE_B_ID },
      );
      expect(mockRepo.findByProjectAndName).toHaveBeenCalledWith(
        SPACE_ID,
        'fig.png',
        PAGE_B_ID,
      );
      expect(saved.pageId).toBe(PAGE_B_ID);
    });

    it('LatexmkEngine promotes output artifacts from nested mainFile directory to options.cwd', async () => {
      const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'latexmk-'));
      try {
        const nestedDir = path.join(tmpCwd, 'paper');
        await fs.mkdir(nestedDir, { recursive: true });
        await fs.writeFile(path.join(nestedDir, 'output.pdf'), '%PDF-1.5');
        await fs.writeFile(path.join(nestedDir, 'output.log'), 'log-ok');
        await fs.writeFile(
          path.join(nestedDir, 'output.synctex.gz'),
          'synctex-ok',
        );

        const runner = {
          name: 'local',
          run: jest.fn().mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
          }),
        };
        const engine = new LatexmkEngine(runner as never);
        const result = await engine.compile({
          cwd: tmpCwd,
          mainFile: 'paper/main.tex',
        });

        expect(result.pdfGenerated).toBe(true);
        expect(result.synctexGenerated).toBe(true);
        expect(
          await fs.readFile(path.join(tmpCwd, 'output.pdf'), 'utf8'),
        ).toBe('%PDF-1.5');
        expect(
          await fs.readFile(path.join(tmpCwd, 'output.log'), 'utf8'),
        ).toBe('log-ok');
      } finally {
        await fs.rm(tmpCwd, { recursive: true, force: true });
      }
    });

    it('WorkspacePlannerService.hydrateFiles uses scratchWorkspaceId and accepts MD5 manifest cache for SHA-hashed PageFile', async () => {
      const tmpScratchRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'planner-scratch-'),
      );
      try {
        const workspaceRepo = new WorkspaceRepository(tmpScratchRoot);
        const pageScratch = await workspaceRepo.ensureScratch(PAGE_B_ID);
        const diskBytes = Buffer.from('cached-png-bytes');
        await fs.writeFile(path.join(pageScratch, 'fig.png'), diskBytes);
        await fs.writeFile(
          path.join(pageScratch, '.clsi-manifest.json'),
          JSON.stringify({
            version: 1,
            files: { 'fig.png': '0123456789abcdef0123456789abcdef' }, // 32-char MD5
            lastUpdated: new Date().toISOString(),
          }),
        );

        const plan = planDbFileSet({
          nodes: [
            {
              id: 'n1',
              docId: DOC_B_MAIN_ID,
              fileId: null,
              path: '/main.tex',
              name: 'main.tex',
              type: 'DOC',
              isRootDoc: true,
            },
            {
              id: 'n2',
              docId: null,
              fileId: 'file-b',
              path: '/fig.png',
              name: 'fig.png',
              type: 'FILE',
              isRootDoc: false,
            },
          ],
          docs: [
            {
              id: DOC_B_MAIN_ID,
              path: '/main.tex',
              rev: 1,
              sizeBytes: 10,
              updatedAt: new Date(),
            },
          ],
          binaryFiles: [
            {
              id: 'file-b',
              name: 'fig.png',
              sizeBytes: diskBytes.length,
              hash: 'a'.repeat(64), // 64-char SHA-256
            },
          ],
          incomingFiles: {},
          source: '',
        });

        const openReadStreamMock = jest.fn();
        const mockPrisma = {
          pageDoc: {
            findMany: jest.fn().mockResolvedValue([
              {
                id: DOC_B_MAIN_ID,
                lines: ['\\documentclass{article}'],
                inStorage: false,
                sizeBytes: 22,
              },
            ]),
          },
        } as unknown as PrismaService;

        const planner = new WorkspacePlannerService(
          mockPrisma,
          undefined,
          { openReadStream: openReadStreamMock } as unknown as FilestoreService,
          undefined,
          workspaceRepo,
        );

        const hydrated = await planner.hydrateFiles(SPACE_ID, plan, PAGE_B_ID);
        expect(hydrated['fig.png']).toEqual(diskBytes);
        expect(openReadStreamMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(tmpScratchRoot, { recursive: true, force: true });
      }
    });
  });
});
