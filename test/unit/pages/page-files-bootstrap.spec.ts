import { resolvePageFilesList } from '@/modules/pages/docstore/controllers/doc.helpers';
import { PrismaService } from '@/core/prisma/prisma.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';

describe('Page Files Bootstrap Contract Suite', () => {
  let mockPrisma: any;
  let mockDocstoreService: any;

  beforeEach(() => {
    mockDocstoreService = {
      getDoc: jest.fn().mockResolvedValue({
        _id: 'doc-1',
        lines: ['\\documentclass{article}', '\\begin{document}', 'Hello World', '\\end{document}'],
      }),
    };

    mockPrisma = {
      pageDoc: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'doc-1',
          spaceId: 'proj-1',
          path: '/main.tex',
          lines: ['\\documentclass{article}', '\\begin{document}', 'Hello World', '\\end{document}'],
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
              path: '/main.tex',
              inStorage: false,
              sizeBytes: 120,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-01T00:00:00Z'),
              ...(hasLinesInSelect
                ? { lines: ['\\documentclass{article}', '\\begin{document}', 'Hello World', '\\end{document}'] }
                : {}),
            },
            {
              id: 'doc-2',
              spaceId: 'proj-1',
              path: '/chapters/intro.tex',
              inStorage: false,
              sizeBytes: 250,
              createdAt: new Date('2026-01-01T00:00:00Z'),
              updatedAt: new Date('2026-01-01T00:00:00Z'),
              ...(hasLinesInSelect
                ? { lines: ['\\section{Introduction}', 'This is a large chapter...'] }
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
            docId: 'doc-1',
            type: 'DOC',
            name: 'main.tex',
            path: '/main.tex',
            isRootDoc: true,
            sizeBytes: 120,
            sortOrder: 0,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'node-2',
            spaceId: 'proj-1',
            docId: 'doc-2',
            type: 'DOC',
            name: 'intro.tex',
            path: '/chapters/intro.tex',
            isRootDoc: false,
            sizeBytes: 250,
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
      mockPrisma as unknown as PrismaService,
      mockDocstoreService as unknown as DocstoreService,
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

    const introFile = result.files.find((f) => f.path === '/chapters/intro.tex');
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
      mockPrisma as unknown as PrismaService,
      mockDocstoreService as unknown as DocstoreService,
      'doc-1',
      'proj-1',
      { includeContent: true },
    );

    expect(result.files).toHaveLength(2);

    const mainFile = result.files.find((f) => f.path === '/main.tex');
    expect(mainFile?.content).toContain('\\documentclass{article}');

    const introFile = result.files.find((f) => f.path === '/chapters/intro.tex');
    expect(introFile?.content).toContain('\\section{Introduction}');

    // Prisma select should have requested lines
    const findManyCall = mockPrisma.pageDoc.findMany.mock.calls[0][0];
    expect(findManyCall.select.lines).toBe(true);
  });
});
