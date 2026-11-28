import { PrismaService } from '@/core';
import { EditorBootstrapService } from '@/modules/pages/bootstrap';
import { DocstoreService } from '@/modules/pages/docstore';
import { PageScaffoldService, PageService } from '@/modules/pages/page';
import { buildClonePlan } from '@/modules/pages/page/services/duplicate.service';
import { resolvePageFilesList } from '@/modules/pages/page/services/query.service';
import { PageNodeEntity } from '@/modules/pages/structure';

const SPACE_ID = '11111111-1111-4111-8111-111111111111';
const PAGE_ID = '22222222-2222-4222-8222-222222222222';
const DOC_MAIN_ID = '33333333-3333-4333-8333-333333333333';
const DOC_INTRO_ID = '44444444-4444-4444-8444-444444444445';
const FILE_ID = '55555555-5555-4555-8555-555555555555';
const BLOB_ID = '66666666-6666-4666-8666-666666666666';

describe('Page Duplication, Scaffolding & Editor Bootstrap Seam', () => {
  describe('buildClonePlan (pure batch clone planner)', () => {
    const makeDeterministicIdGen = () => {
      let seq = 1;
      return () => `gen-id-${seq++}`;
    };

    it('maps root doc to newPageId, groups unsorted nodes by BFS depth, prunes orphans, and aggregates CAS blob refs', () => {
      const plan = buildClonePlan({
        spaceId: SPACE_ID,
        newPageId: PAGE_ID,
        newPageTitle: 'Paper (Copy)',
        sourceRootDocId: 'doc-root',
        sourceDocs: [
          {
            id: 'doc-root',
            lastKnownPath: 'main.tex',
            lines: ['stale'],
            ranges: { title: 'Paper', status: 'draft' },
            hash: 'h1',
            sizeBytes: 12,
          },
          {
            id: 'doc-sec',
            lastKnownPath: 'sections/intro.tex',
            lines: ['\\section{Intro}'],
            ranges: { custom: true },
            hash: 'h2',
            sizeBytes: 15,
          },
        ],
        hydratedDocLinesById: new Map([
          ['doc-root', ['\\documentclass{article}', '\\begin{document}']],
        ]),
        sourceFiles: [
          {
            id: 'f1',
            blobId: 'blob-shared',
            lastKnownPath: 'images/a.png',
            mimeType: 'image/png',
            sizeBytes: 100,
            hash: 'h',
            storageKey: 'k',
            bucketName: 'b',
          },
          {
            id: 'f2',
            blobId: 'blob-shared',
            lastKnownPath: 'images/b.png',
            mimeType: 'image/png',
            sizeBytes: 100,
            hash: 'h',
            storageKey: 'k',
            bucketName: 'b',
          },
        ],
        sourceNodes: [
          // Depth 2 child before depth 1 folder + orphan nodes
          {
            id: 'node-file',
            parentId: 'node-folder',
            type: 'FILE',
            name: 'a.png',
            path: '/images/a.png',
            depth: 2,
            docId: null,
            fileId: 'f1',
            sortOrder: 1,
          },
          {
            id: 'node-root-doc',
            parentId: null,
            type: 'DOC',
            name: 'main.tex',
            path: '/main.tex',
            depth: 1,
            docId: 'doc-root',
            fileId: null,
            sortOrder: 0,
          },
          {
            id: 'node-folder',
            parentId: null,
            type: 'FOLDER',
            name: 'images',
            path: '/images',
            depth: 1,
            docId: null,
            fileId: null,
            sortOrder: 1,
          },
          {
            id: 'orphan-doc',
            parentId: null,
            type: 'DOC',
            name: 'ghost.tex',
            path: '/ghost.tex',
            depth: 1,
            docId: 'missing-doc',
            fileId: null,
          },
        ],
        generateId: makeDeterministicIdGen(),
      });

      expect(plan.clonedRootDocId).toBe(PAGE_ID);
      expect(plan.docsToCreate[0]).toMatchObject({
        id: PAGE_ID,
        pageId: PAGE_ID,
        lines: ['\\documentclass{article}', '\\begin{document}'],
        ranges: { title: 'Paper (Copy)', status: 'draft' },
      });
      expect(plan.docsToCreate[1].ranges).toEqual({ custom: true });

      expect([...plan.nodeBatchesByDepth.keys()].sort((a, b) => a - b)).toEqual(
        [1, 2],
      );
      const depth1 = plan.nodeBatchesByDepth.get(1)!;
      const depth2 = plan.nodeBatchesByDepth.get(2)!;
      expect(depth1).toHaveLength(2);
      expect(depth2).toHaveLength(1);
      expect(depth2[0].parentId).toBe(
        depth1.find((n) => n.type === 'FOLDER')!.id,
      );
      expect(plan.blobIncrements.get('blob-shared')).toBe(2);
    });
  });

  describe('PageService.duplicatePage & PageScaffoldService', () => {
    it('flushes live Yjs sessions BEFORE reading PageDoc.lines, increments Copy suffix, and clones full tree + CAS refs', async () => {
      const now = new Date('2026-06-01T00:00:00Z');
      let liveFlushed = false;

      const sourcePage = {
        id: PAGE_ID,
        spaceId: SPACE_ID,
        rootDocId: DOC_MAIN_ID,
        title: 'Deep Learning Paper',
        description: 'Camera-ready manuscript',
        compiler: 'pdflatex',
        texlive: '2025',
        spellLang: 'en_US',
        settings: { autoCompile: true },
        createdById: null,
        deletedAt: null,
      };

      const makeDocs = () => [
        {
          id: DOC_MAIN_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          lastKnownPath: 'main.tex',
          lines: liveFlushed
            ? ['\\documentclass{article}', '% fresh live-typed line']
            : ['\\documentclass{article}', '% stale line'],
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
          lines: ['\\section{Introduction}'],
          rev: 2,
          version: 2,
          ranges: {},
          hash: 'h-intro',
          sizeBytes: 24,
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
          id: 'node-root',
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
          id: 'node-chapters',
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
          id: 'node-intro',
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          parentId: 'node-chapters',
          type: 'DOC' as const,
          name: 'intro.tex',
          path: '/chapters/intro.tex',
          depth: 2,
          docId: DOC_INTRO_ID,
          fileId: null,
          sortOrder: 0,
        },
      ];

      const createdDocs: Array<Record<string, unknown>> = [];
      const createdNodes: Array<Record<string, unknown>> = [];
      const acquireBlob = jest.fn().mockResolvedValue({});
      const reserveQuota = jest.fn().mockResolvedValue(undefined);
      const flushDocs = jest.fn(async () => {
        liveFlushed = true;
        return [DOC_MAIN_ID];
      });

      const mockPrisma = {
        page: {
          findUnique: jest.fn().mockResolvedValue(sourcePage),
          findMany: jest.fn().mockResolvedValue([
            { title: 'Deep Learning Paper' },
            { title: 'Deep Learning Paper (Copy)' },
          ]),
        },
        pageDoc: {
          findUnique: jest.fn(async () => makeDocs()[0]),
          findFirst: jest.fn(async () => makeDocs()[0]),
          findMany: jest.fn(async () => makeDocs()),
        },
        pageFile: { findMany: jest.fn().mockResolvedValue(sourceFiles) },
        pageNode: { findMany: jest.fn().mockResolvedValue(sourceNodes) },
        $transaction: jest.fn(
          async (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
            cb({
              page: {
                create: jest.fn().mockResolvedValue({}),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
              },
              pageDoc: {
                createMany: jest.fn(
                  async ({ data }: { data: Array<Record<string, unknown>> }) => {
                    createdDocs.push(...data);
                    return { count: data.length };
                  },
                ),
              },
              pageFile: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
              pageNode: {
                createMany: jest.fn(
                  async ({ data }: { data: Array<Record<string, unknown>> }) => {
                    createdNodes.push(...data);
                    return { count: data.length };
                  },
                ),
              },
            }),
        ),
      } as unknown as PrismaService;

      const pageService = new PageService(
        mockPrisma,
        {} as DocstoreService,
        {} as PageScaffoldService,
        undefined,
        {
          applyExternalText: jest.fn(),
          flushDocs,
          flushDoc: jest.fn(),
          evictDoc: jest.fn(),
          getPresence: jest.fn(),
        },
        undefined,
        undefined,
        { acquireBlob, reserveQuota } as never,
      );

      const res = await pageService.duplicatePage(PAGE_ID, SPACE_ID);

      expect(flushDocs).toHaveBeenCalledWith(
        SPACE_ID,
        expect.arrayContaining([DOC_MAIN_ID, DOC_INTRO_ID]),
      );
      expect(reserveQuota).toHaveBeenCalledWith(SPACE_ID, 4096n);
      expect(acquireBlob).toHaveBeenCalledWith(BLOB_ID);
      expect(res.page.id).not.toBe(PAGE_ID);
      expect(res.page.title).toBe('Deep Learning Paper (Copy 2)');
      expect(res.page.content).toContain('% fresh live-typed line');
      expect(createdDocs).toHaveLength(2);
      expect(createdNodes).toHaveLength(3);
      const clonedChapters = createdNodes.find((n) => n.path === '/chapters');
      const clonedIntro = createdNodes.find(
        (n) => n.path === '/chapters/intro.tex',
      );
      expect(clonedIntro?.parentId).toBe(clonedChapters?.id);
    });

    it('scaffolds a new project page atomically with labels inside $transaction without mutating project settings', async () => {
      const LABEL_ID = '99999999-9999-4999-8999-999999999999';
      const projectUpdate = jest.fn();
      const pageLabelCreateMany = jest.fn().mockResolvedValue({ count: 1 });
      const createDoc = jest.fn(async (_spaceId, dto) => ({
        _id: dto.id,
        id: dto.id,
      }));

      const txClient = {
        page: {
          create: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        pageNode: { create: jest.fn().mockResolvedValue({ id: 'node-1' }) },
        pageLabel: { createMany: pageLabelCreateMany },
      };

      const scaffold = new PageScaffoldService(
        {
          project: {
            findUnique: jest.fn().mockResolvedValue({ name: 'Quantum Lab' }),
            update: projectUpdate,
          },
          spaceLabel: {
            findMany: jest.fn().mockResolvedValue([
              { id: LABEL_ID, name: 'NeurIPS', color: '#10b981' },
            ]),
          },
          $transaction: jest.fn(async (cb: (tx: typeof txClient) => unknown) =>
            cb(txClient),
          ),
        } as unknown as PrismaService,
        { createDoc } as unknown as DocstoreService,
      );

      const created = await scaffold.createProjectPage(
        SPACE_ID,
        { title: 'Paper', labelIds: [LABEL_ID] },
        null,
      );

      expect(projectUpdate).not.toHaveBeenCalled();
      expect(createDoc).toHaveBeenCalledWith(
        SPACE_ID,
        expect.objectContaining({ tx: txClient }),
      );
      expect(pageLabelCreateMany).toHaveBeenCalledWith({
        data: [{ pageId: created.page.id, labelId: LABEL_ID }],
        skipDuplicates: true,
      });
    });
  });

  describe('resolvePageFilesList & EditorBootstrapService', () => {
    it('returns metadata-only files by default and hydrates lines only when includeContent=true', async () => {
      const now = new Date('2026-01-01T00:00:00Z');
      const getDoc = jest.fn();
      const mockPrisma = {
        page: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'proj-1',
            spaceId: 'proj-1',
            rootDocId: 'doc-1',
          }),
          findMany: jest.fn().mockResolvedValue([{ rootDocId: 'doc-1' }]),
        },
        pageDoc: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'doc-1',
            spaceId: 'proj-1',
            pageId: 'proj-1',
            lastKnownPath: 'main.tex',
            lines: ['\\documentclass{article}'],
            inStorage: false,
            sizeBytes: 120,
            createdAt: now,
            updatedAt: now,
          }),
          findMany: jest.fn(
            async (args: { select?: { lines?: boolean } } | undefined) => {
              const withLines = Boolean(args?.select?.lines);
              return [
                {
                  id: 'doc-1',
                  spaceId: 'proj-1',
                  pageId: 'proj-1',
                  lastKnownPath: 'main.tex',
                  inStorage: false,
                  sizeBytes: 120,
                  createdAt: now,
                  updatedAt: now,
                  ...(withLines ? { lines: ['\\documentclass{article}'] } : {}),
                },
              ];
            },
          ),
        },
        pageNode: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'node-1',
              spaceId: 'proj-1',
              pageId: 'proj-1',
              docId: 'doc-1',
              type: 'DOC',
              name: 'main.tex',
              path: '/main.tex',
              depth: 1,
              sortOrder: 0,
              createdAt: now,
              updatedAt: now,
            },
          ]),
        },
      } as unknown as PrismaService;

      const metaOnly = await resolvePageFilesList(
        mockPrisma,
        { getDoc } as unknown as DocstoreService,
        'doc-1',
        'proj-1',
      );
      expect(metaOnly.files[0]).toMatchObject({
        id: 'doc-1',
        path: '/main.tex',
        isRootDoc: true,
        size: 120,
        content: '',
      });
      expect(getDoc).not.toHaveBeenCalled();

      const withContent = await resolvePageFilesList(
        mockPrisma,
        { getDoc } as unknown as DocstoreService,
        'doc-1',
        'proj-1',
        { includeContent: true },
      );
      expect(withContent.files[0].content).toBe('\\documentclass{article}');
    });

    it('resolves personal space githubLink by pageId and scopes bootstrap queries to effectivePageId', async () => {
      const now = new Date('2026-07-01T00:00:00Z');
      const githubFindFirst = jest.fn().mockResolvedValue({
        id: 'gh-link-1',
        repoFullName: 'alice/personal-thesis',
        branch: 'main',
        lastSyncedAt: now,
      });
      const getAllNodes = jest.fn().mockResolvedValue([
        new PageNodeEntity({
          id: 'node-root',
          projectId: SPACE_ID,
          spaceId: SPACE_ID,
          pageId: PAGE_ID,
          type: 'DOC',
          name: 'main.tex',
          path: '/main.tex',
          docId: DOC_MAIN_ID,
          isRootDoc: true,
          createdAt: now,
          updatedAt: now,
        }),
      ]);

      const bootstrapService = new EditorBootstrapService(
        {
          project: { findUnique: jest.fn().mockResolvedValue(null) },
          page: {
            findFirst: jest.fn().mockResolvedValue({
              id: PAGE_ID,
              spaceId: SPACE_ID,
              rootDocId: DOC_MAIN_ID,
              title: 'Personal Thesis',
              compiler: 'xelatex',
              texlive: '2025',
              spellLang: 'en_US',
              deletedAt: null,
            }),
            findUnique: jest.fn().mockResolvedValue({
              id: PAGE_ID,
              spaceId: SPACE_ID,
              rootDocId: DOC_MAIN_ID,
              title: 'Personal Thesis',
              deletedAt: null,
            }),
          },
          pageDoc: {
            findFirst: jest.fn().mockResolvedValue({
              id: DOC_MAIN_ID,
              spaceId: SPACE_ID,
              pageId: PAGE_ID,
              lastKnownPath: 'main.tex',
              lines: ['\\documentclass{article}'],
              version: 1,
              rev: 1,
              ranges: {},
              inStorage: false,
              sizeBytes: 24,
              deletedAt: null,
              createdAt: now,
              updatedAt: now,
              node: null,
            }),
            findMany: jest.fn().mockResolvedValue([]),
          },
          pageFile: { findMany: jest.fn().mockResolvedValue([]) },
          pageGithubLink: { findFirst: githubFindFirst },
        } as unknown as PrismaService,
        {
          resolveActiveProjectId: (p?: string) => p,
          resolveProjectId: async () => SPACE_ID,
          getLiveCollaboration: () => null,
        } as never,
        {} as DocstoreService,
        {
          getAllNodes,
          getProjectSymbols: jest.fn().mockResolvedValue({
            rootDocPath: 'main.tex',
            labels: [],
            citations: [],
            customCommands: [],
            customEnvironments: [],
            packages: [],
            bibliographies: [],
            includedFiles: [],
            imageFiles: [],
            files: ['main.tex'],
            images: [],
            outline: [],
          }),
        } as never,
        {
          getLastBuildSummary: jest.fn().mockResolvedValue({
            status: 'uncompiled',
            pdfArtifactUrl: null,
            synctexAvailable: false,
            lastCompiledAt: null,
            diagnostics: [],
          }),
        } as never,
      );

      const res = await bootstrapService.bootstrapEditor({
        pageOrProjectId: SPACE_ID,
        userId: SPACE_ID,
        authorizedProjectId: SPACE_ID,
        role: 'owner',
      });

      expect(res.workspace.spaceType).toBe('personal');
      expect(res.workspace.pageId).toBe(PAGE_ID);
      expect(res.workspace.githubLink).toEqual({
        id: 'gh-link-1',
        repoFullName: 'alice/personal-thesis',
        branch: 'main',
        lastSyncedAt: now.toISOString(),
      });
      expect(githubFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { pageId: PAGE_ID } }),
      );
      expect(getAllNodes).toHaveBeenCalledWith(SPACE_ID, undefined, PAGE_ID);
    });
  });
});
