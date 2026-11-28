import { resolvePageFilesList } from '@/modules/pages/page/services/query.service';
import { EditorBootstrapService } from '@/modules/pages/bootstrap/editor-bootstrap.service';
import { PageNodeEntity } from '@/modules/pages/structure/domain/node.entity';
import { PrismaService } from '@/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';

describe('Page Files Bootstrap Contract Suite', () => {
  let mockPrisma: any;
  let mockDocstoreService: any;

  beforeEach(() => {
    mockDocstoreService = {
      getDoc: jest.fn().mockResolvedValue({
        _id: 'doc-1',
        lines: [
          '\\documentclass{article}',
          '\\begin{document}',
          'Hello World',
          '\\end{document}',
        ],
      }),
    };

    mockPrisma = {
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
          lines: [
            '\\documentclass{article}',
            '\\begin{document}',
            'Hello World',
            '\\end{document}',
          ],
          inStorage: false,
          sizeBytes: 120,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        }),
        findMany: jest.fn().mockImplementation((args: any) => {
          // Verify that lines is only requested when includeContent is true
          const hasLinesInSelect = Boolean(args?.select?.lines);
          return Promise.resolve([
            {
              id: 'doc-1',
              spaceId: 'proj-1',
              pageId: 'proj-1',
              lastKnownPath: 'main.tex',
              inStorage: false,
              sizeBytes: 120,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-01T00:00:00Z'),
              ...(hasLinesInSelect
                ? {
                    lines: [
                      '\\documentclass{article}',
                      '\\begin{document}',
                      'Hello World',
                      '\\end{document}',
                    ],
                  }
                : {}),
            },
            {
              id: 'doc-2',
              spaceId: 'proj-1',
              pageId: 'proj-1',
              lastKnownPath: 'chapters/intro.tex',
              inStorage: false,
              sizeBytes: 250,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-01T00:00:00Z'),
              ...(hasLinesInSelect
                ? {
                    lines: [
                      '\\section{Introduction}',
                      'This is a large chapter...',
                    ],
                  }
                : {}),
            },
          ]);
        }),
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
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'node-2',
            spaceId: 'proj-1',
            pageId: 'proj-1',
            docId: 'doc-2',
            type: 'DOC',
            name: 'intro.tex',
            path: '/chapters/intro.tex',
            depth: 2,
            sortOrder: 1,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
      },
      space: {
        findUnique: jest.fn().mockResolvedValue({ id: 'proj-1' }),
      },
    };
  });

  it('Default (Bootstrap): should return Metadata-Only files without hydrating text content', async () => {
    const result = await resolvePageFilesList(
      mockPrisma,
      mockDocstoreService,
      'doc-1',
      'proj-1',
      // includeContent omitted / false
    );

    expect(result.files).toHaveLength(2);

    // Verify metadata properties are preserved
    const mainFile = result.files.find((f) => f.path === '/main.tex');
    expect(mainFile).toBeDefined();
    expect(mainFile?.id).toBe('doc-1');
    expect(mainFile?.nodeId).toBe('node-1');
    expect(mainFile?.name).toBe('main.tex');
    expect(mainFile?.isRootDoc).toBe(true);
    expect(mainFile?.size).toBe(120);

    // Crucial: content should be empty in metadata mode!
    expect(mainFile?.content).toBe('');

    const introFile = result.files.find(
      (f) => f.path === '/chapters/intro.tex',
    );
    expect(introFile).toBeDefined();
    expect(introFile?.id).toBe('doc-2');
    expect(introFile?.content).toBe('');

    // Prisma select should NOT have requested lines
    const findManyCall = mockPrisma.pageDoc.findMany.mock.calls[0][0];
    expect(findManyCall.select.lines).toBeUndefined();

    // DocstoreService should NOT have been invoked to hydrate docs
    expect(mockDocstoreService.getDoc).not.toHaveBeenCalled();
  });

  it('When includeContent=true: should hydrate text content for all files', async () => {
    const result = await resolvePageFilesList(
      mockPrisma,
      mockDocstoreService,
      'doc-1',
      'proj-1',
      { includeContent: true },
    );

    expect(result.files).toHaveLength(2);

    const mainFile = result.files.find((f) => f.path === '/main.tex');
    expect(mainFile?.content).toContain('\\documentclass{article}');

    const introFile = result.files.find(
      (f) => f.path === '/chapters/intro.tex',
    );
    expect(introFile?.content).toContain('\\section{Introduction}');

    // Prisma select should have requested lines
    const findManyCall = mockPrisma.pageDoc.findMany.mock.calls[0][0];
    expect(findManyCall.select.lines).toBe(true);
  });

  it('EditorBootstrapService: queries pageGithubLink by validPageRow.id, preserves Personal Space githubLink, and strictly scopes pageDoc/pageFile/pageNode to effectivePageId', async () => {
    const PERSONAL_SPACE_ID = '11111111-1111-4111-8111-111111111111';
    const PAGE_ID = '22222222-2222-4222-8222-222222222222';
    const ROOT_DOC_ID = '33333333-3333-4333-8333-333333333333';
    const now = new Date('2026-07-01T00:00:00Z');

    const githubFindFirst = jest.fn().mockResolvedValue({
      id: 'gh-link-1',
      repoFullName: 'alice/personal-thesis',
      branch: 'main',
      lastSyncedAt: now,
    });
    const pageDocFindMany = jest.fn().mockResolvedValue([]);
    const pageFileFindMany = jest.fn().mockResolvedValue([]);
    const getAllNodes = jest.fn().mockResolvedValue([
      new PageNodeEntity({
        id: 'node-root',
        projectId: PERSONAL_SPACE_ID,
        spaceId: PERSONAL_SPACE_ID,
        pageId: PAGE_ID,
        type: 'DOC',
        name: 'main.tex',
        path: '/main.tex',
        docId: ROOT_DOC_ID,
        isRootDoc: true,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    const bootstrapPrisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue(null), // Personal Space -> no Project row!
      },
      page: {
        findFirst: jest.fn().mockResolvedValue({
          id: PAGE_ID,
          spaceId: PERSONAL_SPACE_ID,
          rootDocId: ROOT_DOC_ID,
          title: 'Personal Thesis',
          compiler: 'xelatex',
          texlive: '2025',
          spellLang: 'en_US',
          deletedAt: null,
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: PAGE_ID,
          spaceId: PERSONAL_SPACE_ID,
          rootDocId: ROOT_DOC_ID,
          title: 'Personal Thesis',
          deletedAt: null,
        }),
      },
      pageDoc: {
        findFirst: jest.fn().mockResolvedValue({
          id: ROOT_DOC_ID,
          spaceId: PERSONAL_SPACE_ID,
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
        findMany: pageDocFindMany,
      },
      pageFile: {
        findMany: pageFileFindMany,
      },
      pageGithubLink: {
        findFirst: githubFindFirst,
      },
    } as unknown as PrismaService;

    const bootstrapService = new EditorBootstrapService(
      bootstrapPrisma,
      {
        resolveActiveProjectId: (p?: string) => p,
        resolveProjectId: async () => PERSONAL_SPACE_ID,
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
      pageOrProjectId: PERSONAL_SPACE_ID,
      userId: PERSONAL_SPACE_ID,
      authorizedProjectId: PERSONAL_SPACE_ID,
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
      expect.objectContaining({
        where: { pageId: PAGE_ID },
      }),
    );
    expect(getAllNodes).toHaveBeenCalledWith(
      PERSONAL_SPACE_ID,
      undefined,
      PAGE_ID,
    );
    expect(pageDocFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: PERSONAL_SPACE_ID,
          pageId: PAGE_ID,
        }),
      }),
    );
    expect(pageFileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: PERSONAL_SPACE_ID,
          pageId: PAGE_ID,
        }),
      }),
    );
  });
});
