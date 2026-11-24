import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core';
import { Role } from '@/modules/project/access';
import {
  EditorBootstrapController,
  EditorBootstrapService,
} from '@/modules/pages/bootstrap';
import { ClsiService } from '@/modules/pages/clsi/services/clsi.service';
import { WorkspaceRepository } from '@/modules/pages/clsi/repositories/workspace.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { PageService } from '@/modules/pages/core/services/page.service';
import { PageNodeEntity } from '@/modules/pages/structure/domain';
import {
  StructureService,
  type ProjectSymbolsResponseDto,
} from '@/modules/pages/structure/structure.service';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT_DOC_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_DOC_ID = '33333333-3333-4333-8333-333333333333';
const DELETED_DOC_ID = '44444444-4444-4444-8444-444444444444';
const ASSET_FILE_ID = '55555555-5555-4555-8555-555555555555';

const SAMPLE_SYMBOLS: ProjectSymbolsResponseDto = {
  rootDocPath: '/main.tex',
  labels: [{ key: 'sec:intro', file: '/main.tex', line: 5 }],
  citations: [
    {
      key: 'einstein1905',
      type: 'article',
      title: 'On the Electrodynamics of Moving Bodies',
      author: 'Albert Einstein',
      year: '1905',
      file: '/refs.bib',
      line: 1,
    },
  ],
  customCommands: [],
  customEnvironments: [],
  packages: [{ name: 'amsmath', file: '/main.tex', line: 2 }],
  bibliographies: ['/refs.bib'],
  includedFiles: ['/chapters/intro.tex'],
  imageFiles: ['/figures/fig1.png'],
  files: ['/main.tex', '/chapters/intro.tex'],
  images: ['/figures/fig1.png'],
  outline: [
    {
      title: 'Introduction',
      level: 1,
      levelName: 'section',
      file: '/main.tex',
      line: 4,
      from: 40,
    },
  ],
};

function makeNodeEntity(
  overrides: Partial<{
    id: string;
    parentId: string | null;
    type: 'FOLDER' | 'DOC' | 'FILE';
    name: string;
    path: string;
    docId: string | null;
    fileId: string | null;
    isRootDoc: boolean;
    sizeBytes: number;
    sortOrder: number;
  }>,
) {
  return new PageNodeEntity({
    id: overrides.id ?? 'node-1',
    projectId: PROJECT_ID,
    pageId: PROJECT_ID,
    parentId: overrides.parentId ?? null,
    type: overrides.type ?? 'DOC',
    name: overrides.name ?? 'main.tex',
    path: overrides.path ?? '/main.tex',
    docId: overrides.docId ?? null,
    fileId: overrides.fileId ?? null,
    isRootDoc: overrides.isRootDoc ?? false,
    sizeBytes: overrides.sizeBytes ?? 128,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  });
}

function makeDocRecord(
  id: string,
  docPath: string,
  lines: string[],
  inStorage = true,
) {
  return {
    id,
    spaceId: PROJECT_ID,
    pageId: PROJECT_ID,
    lastKnownPath: docPath,
    lines,
    inStorage,
    version: 3,
    rev: 7,
    ranges: { title: 'Deep Flux Paper' },
    hash: 'abc123',
    sizeBytes: lines.join('\n').length,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    node: {
      id: `node-${id}`,
      name: docPath.split('/').pop() || 'main.tex',
      path: docPath,
    },
  };
}

describe('EditorBootstrapService & ClsiService LastBuild Summary', () => {
  let mockPrisma: any;
  let mockPageService: any;
  let mockDocstoreService: any;
  let mockStructureService: any;
  let mockClsiService: any;
  let mockLiveCollab: { flushDocs: jest.Mock };
  let service: EditorBootstrapService;

  beforeEach(() => {
    const rootDocRecord = makeDocRecord(
      ROOT_DOC_ID,
      '/main.tex',
      ['\\documentclass{article}'],
      true,
    );
    const childDocRecord = makeDocRecord(
      CHILD_DOC_ID,
      '/chapters/intro.tex',
      ['\\section{Intro}'],
      true,
    );

    const nodes = [
      makeNodeEntity({
        id: 'node-folder-1',
        type: 'FOLDER',
        name: 'chapters',
        path: '/chapters',
        sizeBytes: 0,
      }),
      makeNodeEntity({
        id: 'node-root',
        type: 'DOC',
        name: 'main.tex',
        path: '/main.tex',
        docId: ROOT_DOC_ID,
        isRootDoc: true,
        sortOrder: 0,
      }),
      makeNodeEntity({
        id: 'node-child',
        parentId: 'node-folder-1',
        type: 'DOC',
        name: 'intro.tex',
        path: '/chapters/intro.tex',
        docId: CHILD_DOC_ID,
        sortOrder: 1,
      }),
      makeNodeEntity({
        id: 'node-deleted',
        type: 'DOC',
        name: 'trashed.tex',
        path: '/trashed.tex',
        docId: DELETED_DOC_ID,
        sortOrder: 2,
      }),
      makeNodeEntity({
        id: 'node-asset',
        type: 'FILE',
        name: 'fig1.png',
        path: '/figures/fig1.png',
        fileId: ASSET_FILE_ID,
        sizeBytes: 4096,
        sortOrder: 3,
      }),
    ];

    mockLiveCollab = {
      flushDocs: jest.fn().mockResolvedValue([]),
    };

    mockPrisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: PROJECT_ID,
          name: 'Deep Research Paper',
        }),
      },
      page: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      pageGithubLink: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      pageNode: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      pageDoc: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where?.id === ROOT_DOC_ID) return rootDocRecord;
          if (where?.id === CHILD_DOC_ID) return childDocRecord;
          return null;
        }),
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where?.OR) {
            const orList = where.OR as Array<Record<string, any>>;
            if (
              orList.some(
                (c) =>
                  c.id === CHILD_DOC_ID ||
                  c.node?.id === CHILD_DOC_ID ||
                  c.node?.path === '/chapters/intro.tex' ||
                  c.lastKnownPath === '/chapters/intro.tex',
              )
            ) {
              return childDocRecord;
            }
            if (
              orList.some(
                (c) =>
                  c.id === ROOT_DOC_ID ||
                  c.node?.id === ROOT_DOC_ID ||
                  c.node?.path === '/main.tex' ||
                  c.lastKnownPath === '/main.tex',
              )
            ) {
              return rootDocRecord;
            }
            return null;
          }
          if (where?.id === ROOT_DOC_ID) return rootDocRecord;
          if (where?.id === CHILD_DOC_ID) return childDocRecord;
          return null;
        }),
        findMany: jest.fn().mockResolvedValue([{ id: DELETED_DOC_ID }]),
      },
    };

    mockPageService = {
      resolveActiveProjectId: jest.fn((p: any) =>
        typeof p === 'string' ? p : p?.id,
      ),
      resolveProjectId: jest.fn().mockResolvedValue(PROJECT_ID),
      getLiveCollaboration: jest.fn().mockReturnValue(mockLiveCollab),
    };

    mockDocstoreService = {
      getDoc: jest
        .fn()
        .mockImplementation(async (_spaceId: string, docId: string) => ({
          _id: docId,
          id: docId,
          projectId: PROJECT_ID,
          path: docId === CHILD_DOC_ID ? '/chapters/intro.tex' : '/main.tex',
          lines:
            docId === CHILD_DOC_ID
              ? ['\\section{Intro}', 'Hydrated child content']
              : ['\\documentclass{article}', 'Hydrated main content'],
          version: 4,
          rev: 8,
          ranges: { title: 'Deep Research Paper' },
          hash: 'hash-1',
          sizeBytes: 42,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
        })),
    };

    mockStructureService = {
      getAllNodes: jest.fn().mockResolvedValue(nodes),
      getProjectSymbols: jest.fn().mockResolvedValue(SAMPLE_SYMBOLS),
    };

    mockClsiService = {
      getLastBuildSummary: jest
        .fn()
        .mockImplementation(
          async (spaceId: string, _mainFile?: string, pageId?: string) => ({
            status: 'ready',
            pdfArtifactUrl: pageId
              ? `/api/v1/pages/pages/${encodeURIComponent(pageId)}/artifacts/output.pdf`
              : `/api/v1/pages/spaces/${encodeURIComponent(spaceId)}/artifacts/output.pdf`,
            synctexAvailable: true,
            lastCompiledAt: '2026-01-02T12:00:00.000Z',
            diagnostics: [
              {
                file: 'main.tex',
                line: 10,
                message: 'Overfull \\hbox',
                severity: 'badbox',
              },
            ],
          }),
        ),
    };

    service = new EditorBootstrapService(
      mockPrisma,
      mockPageService,
      mockDocstoreService,
      mockStructureService,
      mockClsiService,
      250,
    );
  });

  it('assembles all 3 Editor blocks in 1 pass, excludes deleted nodes, flushes live docs, and hydrates only the active doc', async () => {
    const result = await service.bootstrapEditor({
      pageOrProjectId: ROOT_DOC_ID,
      userId: USER_ID,
      authorizedProjectId: PROJECT_ID,
      role: Role.CONTRIBUTOR,
    });

    // Block 2: Pure (spaceId, pageId, rootDocId) Workspace & active doc — no `scope` field
    expect(result.workspace).toEqual({
      spaceId: PROJECT_ID,
      spaceType: 'project',
      pageId: ROOT_DOC_ID,
      rootDocId: ROOT_DOC_ID,
      projectName: 'Deep Research Paper',
      title: 'Deep Flux Paper',
      mainFilePath: 'main.tex',
      permissions: {
        role: 'contributor',
        canEdit: true,
        canCompile: true,
      },
      githubLink: null,
    });
    expect('scope' in result.workspace).toBe(false);
    expect(result.activeDoc.id).toBe(ROOT_DOC_ID);
    expect(result.activeDoc.nodeId).toBe(`node-${ROOT_DOC_ID}`);
    expect(result.activeDoc.fallbackToRoot).toBe(false);
    expect(result.activeDoc.page.content).toContain('Hydrated main content');

    // Only 1 document hydrated (not every node in tree), and validNodes reused into getProjectSymbols
    expect(mockDocstoreService.getDoc).toHaveBeenCalledTimes(1);
    expect(mockDocstoreService.getDoc).toHaveBeenCalledWith(
      PROJECT_ID,
      ROOT_DOC_ID,
    );
    expect(mockStructureService.getProjectSymbols).toHaveBeenCalledWith(
      PROJECT_ID,
      ROOT_DOC_ID,
      expect.any(Array),
    );

    // Live-Flush Invariant enforced
    expect(mockLiveCollab.flushDocs).toHaveBeenCalledWith(PROJECT_ID, [
      ROOT_DOC_ID,
    ]);

    // Block 1: Unified VFS tree excluding soft-deleted DOC node + symbols
    expect(result.tree.map((n) => n.id)).toEqual([
      'node-folder-1',
      'node-root',
      'node-child',
      'node-asset',
    ]);
    expect(result.symbols).toEqual(SAMPLE_SYMBOLS);

    // Block 3: Page-isolated Metadata-only lastBuild (no PDF binary in JSON)
    expect(result.lastBuild).toEqual({
      status: 'ready',
      pdfArtifactUrl: `/api/v1/pages/pages/${ROOT_DOC_ID}/artifacts/output.pdf`,
      synctexAvailable: true,
      lastCompiledAt: '2026-01-02T12:00:00.000Z',
      diagnostics: [
        {
          file: 'main.tex',
          line: 10,
          message: 'Overfull \\hbox',
          severity: 'badbox',
        },
      ],
    });
    expect(
      (result.lastBuild as unknown as Record<string, unknown>).pdf,
    ).toBeUndefined();
    expect(result.degraded).toBe(false);
    expect(result.degradedBranches).toEqual([]);
  });

  it('sets read-only permissions when user role is reviewer', async () => {
    const result = await service.bootstrapEditor({
      pageOrProjectId: ROOT_DOC_ID,
      userId: USER_ID,
      authorizedProjectId: PROJECT_ID,
      role: Role.REVIEWER,
    });

    expect(result.workspace.permissions).toEqual({
      role: 'reviewer',
      canEdit: false,
      canCompile: false,
    });
  });

  it('coalesces concurrent bootstrap calls via SingleFlightCoalescer', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.bootstrapEditor({
          pageOrProjectId: ROOT_DOC_ID,
          userId: USER_ID,
          authorizedProjectId: PROJECT_ID,
          role: Role.OWNER,
        }),
      ),
    );

    expect(results).toHaveLength(5);
    results.forEach((r) => expect(r.workspace.rootDocId).toBe(ROOT_DOC_ID));
    expect(mockStructureService.getAllNodes).toHaveBeenCalledTimes(1);
    expect(mockStructureService.getProjectSymbols).toHaveBeenCalledTimes(1);
    expect(mockClsiService.getLastBuildSummary).toHaveBeenCalledTimes(1);
    expect(mockDocstoreService.getDoc).toHaveBeenCalledTimes(1);
  });

  it('gracefully falls back to rootDoc when requested ?fileId is missing or deleted', async () => {
    const missingFileId = '99999999-9999-4999-8999-999999999999';
    const result = await service.bootstrapEditor({
      pageOrProjectId: ROOT_DOC_ID,
      userId: USER_ID,
      requestedFileId: missingFileId,
      authorizedProjectId: PROJECT_ID,
    });

    expect(result.activeDoc.id).toBe(ROOT_DOC_ID);
    expect(result.activeDoc.fallbackToRoot).toBe(true);
    expect(result.activeDoc.page.content).toContain('Hydrated main content');
  });

  it('hydrates deep-linked child document without falling back when valid ?fileId is supplied', async () => {
    const result = await service.bootstrapEditor({
      pageOrProjectId: ROOT_DOC_ID,
      userId: USER_ID,
      requestedFileId: CHILD_DOC_ID,
      authorizedProjectId: PROJECT_ID,
    });

    expect(result.activeDoc.id).toBe(CHILD_DOC_ID);
    expect(result.activeDoc.fallbackToRoot).toBe(false);
    expect(result.activeDoc.page.content).toContain('Hydrated child content');
    expect(mockLiveCollab.flushDocs).toHaveBeenCalledWith(PROJECT_ID, [
      ROOT_DOC_ID,
      CHILD_DOC_ID,
    ]);
  });

  it('degrades soft branches cleanly when symbols exceeds deadline and lastBuild errors', async () => {
    mockStructureService.getProjectSymbols.mockImplementation(
      () => new Promise(() => {}), // Never resolves -> hits branch deadline
    );
    mockClsiService.getLastBuildSummary.mockRejectedValue(
      new Error('CLSI scratch unavailable'),
    );

    const result = await service.bootstrapEditor({
      pageOrProjectId: ROOT_DOC_ID,
      userId: USER_ID,
      authorizedProjectId: PROJECT_ID,
      softBranchDeadlineMs: 25,
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedBranches).toEqual(
      expect.arrayContaining(['symbols', 'lastBuild']),
    );
    expect(result.symbols).toBeNull();
    expect(result.lastBuild).toEqual({
      status: 'uncompiled',
      pdfArtifactUrl: null,
      synctexAvailable: false,
      lastCompiledAt: null,
      diagnostics: [],
    });
    expect(result.activeDoc.page.content).toContain('Hydrated main content');
  });

  it('throws NotFoundException when hard branch cannot resolve workspace or root doc', async () => {
    mockPageService.resolveActiveProjectId.mockReturnValue(undefined);
    mockPageService.resolveProjectId.mockResolvedValue(null);

    await expect(
      service.bootstrapEditor({
        pageOrProjectId: 'missing-page-id',
        userId: USER_ID,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('delegates HTTP request params and access context through EditorBootstrapController', async () => {
    const controller = new EditorBootstrapController(service);
    const res = await controller.getEditorBootstrap(
      ROOT_DOC_ID,
      undefined,
      undefined,
      'chapters/intro.tex',
      USER_ID,
      PROJECT_ID,
      { role: Role.OWNER } as any,
    );

    expect(res.activeDoc.id).toBe(CHILD_DOC_ID);
    expect(res.workspace.permissions.role).toBe('owner');
  });

  it('isolates VFS tree, symbols, page title, and CLSI scratch when multiple Pages coexist inside the same Space', async () => {
    const page1Id = '66666666-6666-4666-8666-666666666661';
    const page2Id = '66666666-6666-4666-8666-666666666662';
    const page2ChildId = '66666666-6666-4666-8666-666666666663';

    const page1MainNode = new PageNodeEntity({
      id: 'node-p1-main',
      projectId: USER_ID,
      pageId: page1Id,
      parentId: null,
      type: 'DOC',
      name: 'main.tex',
      path: '/main.tex',
      docId: page1Id,
      isRootDoc: true,
      sizeBytes: 100,
    });
    const page2MainNode = new PageNodeEntity({
      id: 'node-p2-main',
      projectId: USER_ID,
      pageId: page2Id,
      parentId: null,
      type: 'DOC',
      name: 'main.tex',
      path: '/main.tex',
      docId: page2Id,
      isRootDoc: true,
      sizeBytes: 150,
    });
    const page2MethodNode = new PageNodeEntity({
      id: 'node-p2-method',
      projectId: USER_ID,
      pageId: page2Id,
      parentId: null,
      type: 'DOC',
      name: 'method.tex',
      path: '/method.tex',
      docId: page2ChildId,
      isRootDoc: false,
      sizeBytes: 220,
    });

    const page2Doc = {
      ...makeDocRecord(page2Id, '/main.tex', ['\\title{Paper Two}'], false),
      spaceId: USER_ID,
      pageId: page2Id,
      ranges: { title: 'Paper Two (ICML)' },
    };

    mockPageService.resolveActiveProjectId.mockReturnValue(USER_ID);
    mockPrisma.project.findUnique.mockResolvedValue(null); // Personal Space -> projectId null
    mockPrisma.page.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id === page2Id) {
        return {
          id: page2Id,
          spaceId: USER_ID,
          rootDocId: page2Id,
          title: 'Paper Two (ICML)',
          deletedAt: null,
        };
      }
      return null;
    });
    mockPrisma.pageDoc.findUnique.mockImplementation(async ({ where }: any) =>
      where?.id === page2Id ? page2Doc : null,
    );
    mockPrisma.pageDoc.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.id === page2Id) return page2Doc;
      if (where?.OR?.some?.((c: any) => c.id === page2Id)) return page2Doc;
      return null;
    });
    mockStructureService.getAllNodes.mockImplementation(
      async (_spaceId: string, _parentId?: string, reqPageId?: string) => {
        const all = [page1MainNode, page2MainNode, page2MethodNode];
        return reqPageId ? all.filter((n) => n.pageId === reqPageId) : all;
      },
    );

    const result = await service.bootstrapEditor({
      pageOrProjectId: page2Id,
      userId: USER_ID,
      authorizedProjectId: USER_ID,
      role: Role.OWNER,
    });

    // Coordinates strictly use (spaceId=USER_ID, pageId=page2Id, projectId=null) with no `scope`
    expect(result.workspace).toEqual({
      spaceId: USER_ID,
      spaceType: 'personal',
      pageId: page2Id,
      rootDocId: page2Id,
      projectName: null,
      title: 'Paper Two (ICML)',
      mainFilePath: 'main.tex',
      permissions: {
        role: 'owner',
        canEdit: true,
        canCompile: true,
      },
      githubLink: null,
    });
    expect('scope' in result.workspace).toBe(false);

    // Only PAGE_2 nodes are returned (PAGE_1 never leaks)
    expect(result.tree.map((n) => n.id)).toEqual([
      'node-p2-main',
      'node-p2-method',
    ]);
    expect(mockStructureService.getAllNodes).toHaveBeenCalledWith(
      USER_ID,
      undefined,
      page2Id,
    );
    expect(mockStructureService.getProjectSymbols).toHaveBeenCalledWith(
      USER_ID,
      page2Id,
      expect.any(Array),
    );
    expect(mockClsiService.getLastBuildSummary).toHaveBeenCalledWith(
      USER_ID,
      'main.tex',
      page2Id,
    );
    expect(result.lastBuild.pdfArtifactUrl).toBe(
      `/api/v1/pages/pages/${page2Id}/artifacts/output.pdf`,
    );
  });

  it('reads CLSI scratch metadata without loading output.pdf binary in ClsiService.getLastBuildSummary', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clsi-boot-test-'));
    const PAGE_TWO_ID = '77777777-7777-4777-8777-777777777777';
    try {
      const workspaceRepo = new WorkspaceRepository(tmpRoot);
      const clsi = new ClsiService(
        { get: jest.fn(() => undefined) } as unknown as ConfigService,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        workspaceRepo,
      );

      // Initially uncompiled
      const uncompiled = await clsi.getLastBuildSummary(PROJECT_ID, 'main.tex');
      expect(uncompiled).toEqual({
        status: 'uncompiled',
        pdfArtifactUrl: null,
        synctexAvailable: false,
        lastCompiledAt: null,
        diagnostics: [],
      });

      // Populate scratch output artifacts scoped under PAGE_TWO_ID
      const scratchDir = await workspaceRepo.ensureScratch(PAGE_TWO_ID);
      await fs.writeFile(path.join(scratchDir, 'output.pdf'), '%PDF-1.5 mock');
      await fs.writeFile(path.join(scratchDir, 'output.synctex.gz'), 'gzdata');
      await fs.writeFile(
        path.join(scratchDir, 'output.log'),
        '(./main.tex\n! Undefined control sequence.\nl.12 \\badcmd\n)',
      );

      // Another page inside the same space remains strictly uncompiled
      const otherPageSummary = await clsi.getLastBuildSummary(
        PROJECT_ID,
        'main.tex',
        ROOT_DOC_ID,
      );
      expect(otherPageSummary.status).toBe('uncompiled');

      const ready = await clsi.getLastBuildSummary(
        PROJECT_ID,
        'main.tex',
        PAGE_TWO_ID,
      );
      expect(ready.status).toBe('ready');
      expect(ready.pdfArtifactUrl).toBe(
        `/api/v1/pages/pages/${PAGE_TWO_ID}/artifacts/output.pdf`,
      );
      expect(ready.synctexAvailable).toBe(true);
      expect(ready.lastCompiledAt).toBeTruthy();
      expect(ready.diagnostics.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('populates workspace.githubLink in Phase 1 when pageGithubLink exists', async () => {
    const lastSynced = new Date('2026-02-10T09:30:00.000Z');
    mockPrisma.pageGithubLink.findFirst.mockResolvedValue({
      id: 'gh-link-42',
      repoFullName: 'flux-lab/manuscript-paper',
      branch: 'paper-draft',
      lastSyncedAt: lastSynced,
    });

    const result = await service.bootstrapEditor({
      pageOrProjectId: ROOT_DOC_ID,
      userId: USER_ID,
      authorizedProjectId: PROJECT_ID,
      role: Role.OWNER,
    });

    expect(result.workspace.projectName).toBe('Deep Research Paper');
    expect(result.workspace.githubLink).toEqual({
      id: 'gh-link-42',
      repoFullName: 'flux-lab/manuscript-paper',
      branch: 'paper-draft',
      lastSyncedAt: lastSynced.toISOString(),
    });
  });
});
