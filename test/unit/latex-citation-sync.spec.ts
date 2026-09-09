import { LatexService } from '../../src/modules/document/latex/latex.service';

describe('LatexService - Citation and references.bib auto-sync', () => {
  let service: LatexService;
  let mockConfigService: any;
  let mockPageService: any;
  let mockExportsService: any;
  let mockPrisma: any;

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn().mockReturnValue('http://localhost:2918'),
    };
    mockPageService = {
      checkUserAccess: jest.fn().mockResolvedValue(true),
      checkProjectAccess: jest.fn().mockResolvedValue(true),
      findPageById: jest.fn(),
    };
    mockExportsService = {
      exportByCitationKeys: jest.fn().mockResolvedValue({
        content:
          '@article{vaswani2017attention,\n  title = {Attention Is All You Need}\n}',
        count: 1,
        foundKeys: ['vaswani2017attention'],
        missingKeys: [],
      }),
    };
    mockPrisma = {
      page: {
        findUnique: jest.fn().mockResolvedValue({ workspaceId: 'ws-123' }),
      },
      project: {
        findUnique: jest.fn().mockResolvedValue({ workspaceId: 'ws-123' }),
      },
    };

    service = new LatexService(
      mockConfigService,
      mockPageService,
      undefined,
      mockExportsService,
      mockPrisma,
    );

    // Mock executeFetch and parseCompilerResponse
    (service as any).executeFetch = jest.fn().mockResolvedValue(new Response());
    (service as any).parseCompilerResponse = jest.fn().mockResolvedValue({
      success: true,
      pdf: 'JVBERi0xLjQK...',
      synctex: '',
    });
  });

  it('automatically detects citekeys in LaTeX source and injects references.bib into compiler payload', async () => {
    const source = `
      \\documentclass{article}
      \\begin{document}
      According to \\cite{vaswani2017attention}, transformers are effective.
      \\bibliography{references}
      \\end{document}
    `;

    const result = await service.compile({
      pageId: 'page-abc',
      source,
    });

    expect(result.success).toBe(true);
    expect(mockExportsService.exportByCitationKeys).toHaveBeenCalledWith(
      'ws-123',
      ['vaswani2017attention'],
    );

    expect((service as any).executeFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        files: expect.objectContaining({
          'references.bib': expect.stringContaining(
            '@article{vaswani2017attention',
          ),
        }),
      }),
    );
  });

  it('does not invoke exportByCitationKeys when source has no citation commands', async () => {
    const source = `
      \\documentclass{article}
      \\begin{document}
      Hello world without citations.
      \\end{document}
    `;

    await service.compile({
      pageId: 'page-abc',
      source,
    });

    expect(mockExportsService.exportByCitationKeys).not.toHaveBeenCalled();
  });
});
