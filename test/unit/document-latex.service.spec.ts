import { Test, TestingModule } from '@nestjs/testing';
import {
  CompilerService,
  LatexService,
} from '@/modules/document/compiler/compiler.service';
import { PageService } from '@/modules/document/page/page.service';
import { ConfigService } from '@nestjs/config';
import { LibraryFacade } from '@/modules/library/library.facade';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { ForbiddenException } from '@nestjs/common';

describe('Document LatexService (Server-Authoritative Multi-file Assembly & Compilation)', () => {
  let service: LatexService;
  let pageService: jest.Mocked<PageService>;
  let libraryFacade: jest.Mocked<LibraryFacade>;
  let prisma: any;
  let cache: jest.Mocked<RedisCacheService>;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockPageId = '22222222-2222-2222-2222-222222222222';
  const mockProjectId = '33333333-3333-3333-3333-333333333333';

  const mockRootPage: any = {
    id: mockPageId,
    title: 'Quantum Computing Survey',
    content:
      '\\section{Overview}\nSee \\cite{nielsen2010} and \\input{methods}',
    projectId: mockProjectId,
    authorId: mockUserId,
    mainFileId: null,
    childPages: [
      {
        id: 'child-1',
        title: 'methods.tex',
        content: '\\section{Methods}\nDetailed algorithmic analysis.',
      },
    ],
  };

  beforeEach(async () => {
    const mockPageService = {
      checkUserAccess: jest.fn().mockResolvedValue(true),
      checkProjectAccess: jest.fn().mockResolvedValue(true),
      findPageById: jest.fn().mockResolvedValue(mockRootPage),
    };

    const mockLibraryFacade = {
      exportBibByCitationKeys: jest.fn().mockResolvedValue({
        content:
          '@article{nielsen2010, title={Quantum Computation}, author={Nielsen, M.}}\n',
      }),
    };

    const mockConfigService = {
      get: jest.fn().mockReturnValue('http://localhost:2918'),
    };

    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    prisma = {
      page: {
        findUnique: jest.fn().mockResolvedValue({ authorId: mockUserId }),
      },
      project: {
        findUnique: jest.fn().mockResolvedValue({ createdById: mockUserId }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LatexService,
        { provide: PageService, useValue: mockPageService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: LibraryFacade, useValue: mockLibraryFacade },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisCacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<LatexService>(LatexService);
    pageService = module.get(PageService);
    libraryFacade = module.get(LibraryFacade);
    cache = module.get(RedisCacheService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('compile', () => {
    it('should reject compilation if user has no permission', async () => {
      pageService.checkUserAccess.mockResolvedValue(false);

      await expect(
        service.compile({ page_id: mockPageId }, mockUserId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should compile from database assembly when source is omitted', async () => {
      const mockCompilerResponse = {
        success: true,
        pdf: 'JVBERi0xLjQKJcfs...',
        synctex: 'SyncTeX Version:1\nInput:1:main.tex',
        logs: 'Tectonic output: Finished processing.',
        diagnostics: [],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (header: string) =>
            header === 'content-type' ? 'application/json' : null,
        },
        json: jest.fn().mockResolvedValue(mockCompilerResponse),
      } as any);

      const result = await service.compile(
        {
          page_id: mockPageId,
          use_cache: false,
        },
        mockUserId,
      );

      expect(pageService.findPageById).toHaveBeenCalledWith(mockPageId);
      expect(libraryFacade.exportBibByCitationKeys).toHaveBeenCalledWith(
        mockUserId,
        expect.arrayContaining(['nielsen2010']),
      );

      // Verify payload sent to compiler has assembled child files + references.bib
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:2918/compile',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('references.bib'),
        }),
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.pdf).toBe('JVBERi0xLjQKJcfs...');
        expect(result.synctex).toContain('SyncTeX');
      }
    });

    it('should wrap bare manuscript fragment in standard LaTeX boilerplate', async () => {
      const mockCompilerResponse = {
        success: true,
        pdf: 'PDF_BASE64_DATA',
        logs: 'Ok',
      };

      let sentBody: any = null;
      global.fetch = jest.fn().mockImplementation((_url: string, opts: any) => {
        sentBody = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'application/json' },
          json: () => Promise.resolve(mockCompilerResponse),
        });
      });

      await service.compile({
        source: 'This is a simple manuscript paragraph without documentclass.',
        use_cache: false,
      });

      expect(sentBody.source).toContain(
        '\\documentclass[11pt,a4paper]{article}',
      );
      expect(sentBody.source).toContain('\\begin{document}');
      expect(sentBody.source).toContain(
        'This is a simple manuscript paragraph without documentclass.',
      );
      expect(sentBody.source).toContain('\\end{document}');
    });

    it('should return structured diagnostics when compilation fails', async () => {
      const mockFailResponse = {
        success: false,
        error: 'LaTeX compilation failed',
        logs: '! Undefined control sequence: \\unknowntest',
        diagnostics: [
          {
            file: 'main.tex',
            line: 4,
            message: 'Undefined control sequence',
            context: '\\unknowntest',
            severity: 'error',
            suggestion: 'Check command spelling',
          },
        ],
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: jest.fn().mockResolvedValue(mockFailResponse),
      } as any);

      const result = await service.compile({
        source:
          '\\documentclass{article}\n\\begin{document}\n\\unknowntest\n\\end{document}',
        use_cache: false,
      });

      expect(result.success).toBe(false);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics?.[0].line).toBe(4);
      expect(result.diagnostics?.[0].severity).toBe('error');
    });

    it('should return cached result when cache hit occurs', async () => {
      const cachedResult: any = {
        success: true,
        pdf: 'CACHED_PDF',
        synctex: 'CACHED_SYNCTEX',
      };
      cache.get.mockResolvedValue(cachedResult);
      global.fetch = jest.fn();

      const result = await service.compile({
        source: '\\documentclass{article}\\begin{document}Hello\\end{document}',
        use_cache: true,
      });

      expect(result).toEqual(cachedResult);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should save compiled result to cache with safe 300s TTL when within 2MB limit', async () => {
      cache.get.mockResolvedValue(null);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: () =>
          Promise.resolve({
            success: true,
            pdf: 'JVBERi0xLjQKJcfs...',
            synctex: 'sync',
          }),
      } as any);

      await service.compile({
        source: '\\documentclass{article}\\begin{document}Hello\\end{document}',
        use_cache: true,
      });

      expect(cache.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ success: true, pdf: 'JVBERi0xLjQKJcfs...' }),
        300, // 5 minutes TTL
      );
    });

    it('should NOT cache PDF in Redis if base64 size exceeds 2MB limit to prevent RAM exhaustion', async () => {
      cache.get.mockResolvedValue(null);
      const massivePdf = 'A'.repeat(2.5 * 1024 * 1024); // 2.5 MB base64

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: () =>
          Promise.resolve({
            success: true,
            pdf: massivePdf,
          }),
      } as any);

      await service.compile({
        source: '\\documentclass{article}\\begin{document}Massive PDF\\end{document}',
        use_cache: true,
      });

      expect(cache.set).not.toHaveBeenCalled();
    });

    it('should parse raw logs and extract primary error when compiler returns unformatted logs', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'application/json' },
        json: () =>
          Promise.resolve({
            success: false,
            error: 'LaTeX compilation failed',
            logs: 'This is pdfTeX\n! Undefined control sequence.\nl.42 \\invalidMacro\nTranscript written.',
          }),
      } as any);

      const result = await service.compile({
        source: '\\documentclass{article}\\begin{document}\\invalidMacro\\end{document}',
        use_cache: false,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('! Undefined control sequence. on line 42');
        expect(result.diagnostics).toBeDefined();
        expect(result.diagnostics?.[0].line).toBe(42);
        expect(result.diagnostics?.[0].suggestion).toContain('\\usepackage');
      }
    });
  });

  describe('getWordCount', () => {
    it('should query latex-compiler word-count endpoint and return academic statistics', async () => {
      const mockWordCountResponse = {
        success: true,
        stats: {
          wordsInText: 1450,
          wordsInHeaders: 35,
          wordsInCaptions: 80,
          headers: 6,
          floats: 4,
          mathInlines: 12,
          mathDisplayed: 5,
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockWordCountResponse),
      } as any);

      const result = await service.getWordCount(
        '\\section{Introduction}\nHere are some academic words.\n$E = mc^2$',
      );

      expect(result.success).toBe(true);
      expect(result.stats?.wordsInText).toBe(1450);
      expect(result.stats?.headers).toBe(6);
    });

    it('should return error when word count service is unreachable', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Connection refused'));

      const result = await service.getWordCount('Some text');

      expect(result.success).toBe(false);
      expect(result.error).toContain('unreachable');
    });
  });
});
