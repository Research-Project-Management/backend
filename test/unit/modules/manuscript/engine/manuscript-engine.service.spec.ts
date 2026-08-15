import { Test, TestingModule } from '@nestjs/testing';
import { ManuscriptEngineService } from '@/modules/manuscript/engine/manuscript-engine.service';
import { LatexService } from '@/modules/manuscript/latex/latex.service';
import { PageRepository } from '@/modules/manuscript/page/page.repository';
import { VersionRepository } from '@/modules/manuscript/version/version.repository';
import { LatexEngine } from '@/modules/manuscript/latex/dto/latex.dto';

describe('ManuscriptEngineService', () => {
  let service: ManuscriptEngineService;
  let pageRepo: PageRepository;
  let versionRepo: VersionRepository;
  let latexService: LatexService;

  const mockPageRepo = {
    findPageById: jest.fn(),
    findPageWithVersions: jest.fn(),
    findChildPages: jest.fn(),
    updatePage: jest.fn(),
  };

  const mockVersionRepo = {
    createVersion: jest.fn(),
    findVersionById: jest.fn(),
  };

  const mockLatexService = {
    syncProject: jest
      .fn()
      .mockResolvedValue({ ok: true, synced: 3, rootPageId: 'page-1' }),
    compile: jest
      .fn()
      .mockResolvedValue({ status: 'ok', pdf: 'JVBERi0xLjQK...', synctex: '' }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManuscriptEngineService,
        { provide: PageRepository, useValue: mockPageRepo },
        { provide: VersionRepository, useValue: mockVersionRepo },
        { provide: LatexService, useValue: mockLatexService },
      ],
    }).compile();

    service = module.get<ManuscriptEngineService>(ManuscriptEngineService);
    pageRepo = module.get<PageRepository>(PageRepository);
    versionRepo = module.get<VersionRepository>(VersionRepository);
    latexService = module.get<LatexService>(LatexService);
  });

  describe('saveAndSync', () => {
    it('should save page, create a version snapshot, and trigger LaTeX project sync', async () => {
      const mockPage = {
        id: 'page-1',
        title: 'Introduction to Quantum Computing',
        content: 'Initial text',
        parentPageId: null,
        versions: [],
      };
      mockPageRepo.findPageWithVersions.mockResolvedValue(mockPage);
      mockPageRepo.updatePage.mockResolvedValue({
        ...mockPage,
        content: 'Updated draft content',
        author: {
          id: 'u-1',
          name: 'Alice',
          email: 'alice@test.com',
          avatar: null,
        },
      });
      mockVersionRepo.createVersion.mockResolvedValue({
        id: 'ver-1',
        pageId: 'page-1',
        title: 'Introduction to Quantum Computing',
        content: 'Updated draft content',
        label: 'Auto-save snapshot',
        savedById: 'u-1',
        eventType: 'auto_save',
      });

      const result = await service.saveAndSync('page-1', 'u-1', {
        title: 'Introduction to Quantum Computing',
        content: 'Updated draft content',
        createSnapshot: true,
      });

      expect(result.page.id).toBe('page-1');
      expect(result.snapshotCreated).toBe(true);
      expect(result.version).toBeDefined();
      expect(mockLatexService.syncProject).toHaveBeenCalledWith('page-1');
    });
  });

  describe('buildManuscript', () => {
    it('should assemble root and child chapters into LaTeX source and compile to PDF', async () => {
      const mockRoot = {
        id: 'page-root',
        title: 'Thesis on Deep Learning',
        content: 'Abstract and introduction text',
      };
      const mockSections = [
        {
          id: 'page-sec-1',
          title: 'Related Work',
          content: 'Discussion of prior art',
        },
        {
          id: 'page-sec-2',
          title: 'Methodology',
          content: 'Architecture details',
        },
      ];
      mockPageRepo.findPageById.mockResolvedValue(mockRoot);
      mockPageRepo.findChildPages.mockResolvedValue(mockSections);

      const result = await service.buildManuscript('page-root', {
        engine: LatexEngine.PDFLATEX,
      });

      expect(result.manuscriptId).toBe('page-root');
      expect(result.sectionsCount).toBe(2);
      expect(result.pdf).toBe('JVBERi0xLjQK...');
      expect(mockLatexService.compile).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'page-root',
          engine: LatexEngine.PDFLATEX,
          source: expect.stringContaining('\\section{Related Work}'),
        }),
      );
    });
  });

  describe('rollbackAndSync', () => {
    it('should rollback page content and trigger compiler tree resync', async () => {
      mockVersionRepo.findVersionById.mockResolvedValue({
        id: 'ver-old',
        title: 'Old Title',
        content: 'Old pristine content',
      });
      mockPageRepo.updatePage.mockResolvedValue({
        id: 'page-1',
        title: 'Old Title',
        content: 'Old pristine content',
        author: {
          id: 'u-1',
          name: 'Alice',
          email: 'alice@test.com',
          avatar: null,
        },
      });

      const result = await service.rollbackAndSync('page-1', 'ver-old');
      expect(result.versionId).toBe('ver-old');
      expect(result.restoredPage.title).toBe('Old Title');
      expect(mockLatexService.syncProject).toHaveBeenCalledWith('page-1');
    });
  });
});
